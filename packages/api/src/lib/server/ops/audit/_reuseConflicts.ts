import { sql } from 'kysely';

import {
  liveHolder,
  type Collision,
  type Column,
  type HolderSpec,
  type LiveTable
} from '../liveHolder.js';
import { Conflict, type Context } from '../types.js';

type ReuseCheck = (ctx: Context, id: string) => Promise<Collision | null>;

/**
 * The check for a `table` whose live rows keep each of `unique`'s column sets unique (§11.2): the
 * live row other than the revived one holding the revived row's values of one set. A set with a
 * NULL value collides with nobody, as SQLite lets any number of rows hold NULL in a unique index.
 */
function uniqueAmongLive<T extends LiveTable>(
  table: T,
  kind: string,
  label: Column<T>,
  ...unique: Column<T>[][]
): ReuseCheck {
  return async (ctx, id) => {
    const from: LiveTable = table;
    const columns: string[] = unique.flat();
    const row = await ctx.db
      .selectFrom(from)
      .select(
        columns.map(column =>
          sql.ref<string | number | null>(column).as(column)
        )
      )
      .where(sql.ref('id'), '=', id)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    const holders = await Promise.all(
      unique.map(async set => {
        const values: HolderSpec<T>['values'] = {};
        for (const column of set) {
          const value = row[column];
          if (value === null || value === undefined) {
            return null;
          }
          values[column] = value;
        }
        return liveHolder(ctx.db, { table, kind, label, values }, id);
      })
    );
    return holders.find(holder => holder !== null) ?? null;
  };
}

const sipUsernameConflict = uniqueAmongLive('devices', 'device', 'label', [
  'sipUsername'
]);

/**
 * The device check: the SIP username, and the user's live Ringotel device a revived Ringotel
 * device would join, a user having at most one (`devices_one_ringotel_per_user`, §11.2).
 */
async function deviceReuseConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('devices')
    .select(['userId', 'kind'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row?.kind !== 'ringotel') {
    return sipUsernameConflict(ctx, id);
  }
  return (
    (await sipUsernameConflict(ctx, id)) ??
    (await liveHolder(
      ctx.db,
      {
        table: 'devices',
        kind: 'device',
        label: 'label',
        values: { userId: row.userId, kind: 'ringotel' }
      },
      id
    ))
  );
}

/**
 * The live schedule of the same scope a revived opening-hours schedule would collide with: one
 * live schedule per user, ring group or menu (`opening_hours_scope_*`) and one tenant schedule,
 * all three scopes NULL (`opening_hours_tenant_single`, §11.2). `hours.set` on a scope whose
 * schedule is soft-deleted inserts a new one, so undoing the old `hours.delete` would bring back
 * a second.
 */
async function scheduleReuseConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('openingHours')
    .select(['scopeUserId', 'scopeRingGroupId', 'scopeMenuId'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const holder = await liveHolder(
    ctx.db,
    { table: 'openingHours', kind: 'openingHours', label: 'id', values: row },
    id
  );
  return holder && { ...holder, label: 'opening hours' };
}

/**
 * The reuse-eligible unique-value check for each entity kind whose live-row uniqueness is scoped
 * by `deleted_at IS NULL` (§11.2), so a soft-deleted row's value is free the moment a new row takes
 * it (§5.9) and an undo bringing the old row back must refuse to collide with that new row (§5.8).
 * A trunk's priority is among them: a trunk created since appends past every live trunk, and
 * `trunks.setOrder` renumbers the live ones from 1 (§9.4 "Trunk order"). A user's extension is
 * checked by `revertExtension`, since it lives in `extensions`. `outbound_routes_priority` needs
 * no check: a route comes back only through `outboundRoutes.replace`, which renumbers every route
 * it keeps.
 */
const REUSE_CONFLICT_CHECKS: Partial<Record<string, ReuseCheck>> = {
  user: uniqueAmongLive('users', 'user', 'name', ['email'], ['ssoSubject']),
  device: deviceReuseConflict,
  ringGroup: uniqueAmongLive('ringGroups', 'ringGroup', 'name', ['name']),
  userGroup: uniqueAmongLive('userGroups', 'userGroup', 'name', ['name']),
  menu: uniqueAmongLive('menus', 'menu', 'name', ['name']),
  trunk: uniqueAmongLive('trunks', 'trunk', 'name', ['name'], ['priority']),
  did: uniqueAmongLive('dids', 'did', 'number', ['number']),
  didBlock: uniqueAmongLive('didBlocks', 'didBlock', 'base', ['base']),
  audio: uniqueAmongLive('audioAssets', 'audio', 'label', ['filename']),
  blockedNumber: uniqueAmongLive('blockedNumbers', 'blockedNumber', 'number', [
    'number',
    'isPrefix'
  ]),
  openingHours: scheduleReuseConflict
};

/** Refuses the revert with a 409 naming the newer row, if reviving the entity would collide with it. */
export async function guardReuseConflict(
  ctx: Context,
  entityKind: string,
  entityId: string
): Promise<void> {
  const check = REUSE_CONFLICT_CHECKS[entityKind];
  if (!check) {
    return;
  }
  const conflict = await check(ctx, entityId);
  if (conflict) {
    throw new Conflict(`audit.undo: ${entityKind} value already taken`, [
      conflict
    ]);
  }
}
