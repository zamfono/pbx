import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { Db, DB } from '@zamfono/shared';

import { targetInputSchema } from '../dids/_shared.js';
import { OpError, type Actor } from '../types.js';

export type OooRuleRow = Selectable<DB['oooRules']>;

/**
 * The wire shape of an `ooo_rules`/`opening_hours` scope (§11.2): the path a `GET/POST
 * /users/{id}/ooo`-style route resolves to before calling the operation. `tenant` carries no id,
 * since all three scope columns are NULL for it.
 */
export const scopeInputSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('tenant') }),
    z.object({ kind: z.literal('user'), id: z.string() }),
    z.object({ kind: z.literal('ringGroup'), id: z.string() }),
    z.object({ kind: z.literal('menu'), id: z.string() })
  ])
  .describe(
    "Whose it is: the tenant, or a user, ring group or menu by id; a call's target uses its own, else the tenant's."
  );

/** The meaning of each `ooo.create`/`ooo.update` field (§10.2 "Out of office", §11.2 `ooo_rules`). */
export type ScopeInput = z.infer<typeof scopeInputSchema>;

/**
 * `startsAt`/`expiresAt` on input: ISO-8601, any offset (clients send local time), normalized to
 * UTC via `toUtcIso` before it reaches the overlap check or the `_at` column (Global Constraints:
 * "Timestamps TEXT ISO 8601 UTC").
 */
export const isoDatetimeInput = z.iso.datetime({ offset: true });

/** The fields `ooo.create` takes and `ooo.update` takes each optionally (§10.3). */
export const oooFields = {
  active: z
    .boolean()
    .optional()
    .describe('Whether the rule applies at all; on by default.'),
  startsAt: isoDatetimeInput
    .nullable()
    .optional()
    .describe(
      'When the rule takes effect, ISO 8601 with an offset; null: immediately.'
    ),
  expiresAt: isoDatetimeInput
    .nullable()
    .optional()
    .describe(
      'When the rule ends, after startsAt; null: until deactivated. Active periods within a scope must not overlap.'
    ),
  target: targetInputSchema.describe(
    "Where the scope's calls go while the rule is in effect, ahead of opening hours (see zamfono.help vacation-rule)."
  )
};

/** `value` as a UTC ISO-8601 string, so stored `_at` values compare and parse consistently. */
export function toUtcIso(value: string): string {
  return new Date(value).toISOString();
}

/** `toUtcIso` over an optional/nullable input field, preserving "absent" vs. explicit `null`. */
export function normalizeIsoOrNull(
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return toUtcIso(value);
}

export type ScopeColumns = {
  scopeUserId: string | null;
  scopeRingGroupId: string | null;
  scopeMenuId: string | null;
};

/** The exclusive-arc scope columns (§11.1 "References") `scope` resolves to for an insert. */
export function scopeColumns(scope: ScopeInput): ScopeColumns {
  return {
    scopeUserId: scope.kind === 'user' ? scope.id : null,
    scopeRingGroupId: scope.kind === 'ringGroup' ? scope.id : null,
    scopeMenuId: scope.kind === 'menu' ? scope.id : null
  };
}

/** The inverse of `scopeColumns`: a row's scope columns back to the wire `ScopeInput`. */
export function scopeFromColumns(row: ScopeColumns): ScopeInput {
  if (row.scopeUserId !== null) {
    return { kind: 'user', id: row.scopeUserId };
  }
  if (row.scopeRingGroupId !== null) {
    return { kind: 'ringGroup', id: row.scopeRingGroupId };
  }
  if (row.scopeMenuId !== null) {
    return { kind: 'menu', id: row.scopeMenuId };
  }
  return { kind: 'tenant' };
}

const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;

/** Whether `actor` may act on `scope`: a `user` only their own user scope, `admin`/`owner` any. */
function ownsScope(actor: Actor, scope: ScopeInput): boolean {
  return (
    actor.role !== 'user' || (scope.kind === 'user' && scope.id === actor.id)
  );
}

/**
 * §10.3 "Out of Office"/"Opening hours": a `user` acts only on their own user scope; `admin` and
 * `owner` act on any scope. `minRole: 'user'` on these operations defers the rest of RBAC here.
 * For a scope-addressed route (the scope itself is the input, nothing to enumerate) a mismatch is
 * a plain 403.
 */
export function assertOwnScopeOrAdmin(actor: Actor, scope: ScopeInput): void {
  if (!ownsScope(actor, scope)) {
    throw new OpError(STATUS_FORBIDDEN, 'forbidden');
  }
}

/**
 * `assertOwnScopeOrAdmin`, for an id-addressed route: `update`/`delete` already resolved `scope`
 * from a rule the caller named by id, so a 403 there would let a `user` tell an existing rule in
 * someone else's scope apart from an unknown id. Both answer `notFoundMessage` (404) instead.
 */
export function assertVisibleScope(
  actor: Actor,
  scope: ScopeInput,
  notFoundMessage: string
): void {
  if (!ownsScope(actor, scope)) {
    throw new OpError(STATUS_NOT_FOUND, notFoundMessage);
  }
}

/**
 * Whether the half-open periods `[aStart, aEnd)` and `[bStart, bEnd)` intersect, `null` standing
 * for the unbounded side (§11.2 `ooo_rules`: NULL `starts_at` = immediately, NULL `expires_at` =
 * until deactivated). An open-ended period therefore overlaps every later period.
 */
export function rangesOverlap(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null
): boolean {
  const aStartsBeforeBEnds = aStart === null || bEnd === null || aStart < bEnd;
  const bStartsBeforeAEnds = bStart === null || aEnd === null || bStart < aEnd;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/** Loads a live `ooo_rules` row by id, or `undefined` when absent or soft-deleted. */
export async function loadLiveOooRule(
  db: Db,
  id: string
): Promise<OooRuleRow | undefined> {
  return db
    .selectFrom('oooRules')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}

/**
 * Every live `ooo_rules` row in `scope`, in `starts_at` order (NULLs, meaning "now", first), ties
 * broken by id so `ooo.list`'s offset cursor resumes on a stable order.
 */
export async function liveOooRulesInScope(
  db: Db,
  scope: ScopeInput
): Promise<OooRuleRow[]> {
  const columns = scopeColumns(scope);
  return db
    .selectFrom('oooRules')
    .selectAll()
    .where(
      'scopeUserId',
      columns.scopeUserId === null ? 'is' : '=',
      columns.scopeUserId
    )
    .where(
      'scopeRingGroupId',
      columns.scopeRingGroupId === null ? 'is' : '=',
      columns.scopeRingGroupId
    )
    .where(
      'scopeMenuId',
      columns.scopeMenuId === null ? 'is' : '=',
      columns.scopeMenuId
    )
    .where('deletedAt', 'is', null)
    .orderBy('startsAt')
    .orderBy('id')
    .execute();
}
