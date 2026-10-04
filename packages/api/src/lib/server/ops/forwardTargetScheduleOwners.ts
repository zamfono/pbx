import type { Db } from '@zamfono/shared';

import type { OwnScope } from './forwardTargetOwners.js';

/** The out-of-office rules and opening-hours schedules still pointing at one of the targets. */
export type ScheduleSources = {
  ooo: { id: string }[];
  hours: { id: string }[];
};

/**
 * `ooo_rules.target_id`, outside `exclude`'s own scope and outside every
 * soft-deleted scope, whose rules travel with it (§5.9). A left join leaves the scope's
 * `deleted_at` NULL wherever the scope column is NULL, which keeps the tenant-wide rows in.
 */
async function loadScopedOooRules(
  db: Db,
  ftIds: string[],
  exclude: OwnScope
): Promise<{ id: string }[]> {
  let query = db
    .selectFrom('oooRules')
    .leftJoin('users as scopeUser', 'scopeUser.id', 'oooRules.scopeUserId')
    .leftJoin(
      'ringGroups as scopeGroup',
      'scopeGroup.id',
      'oooRules.scopeRingGroupId'
    )
    .leftJoin('menus as scopeMenu', 'scopeMenu.id', 'oooRules.scopeMenuId')
    .select('oooRules.id as id')
    .where('oooRules.targetId', 'in', ftIds)
    .where('oooRules.deletedAt', 'is', null)
    .where('scopeUser.deletedAt', 'is', null)
    .where('scopeGroup.deletedAt', 'is', null)
    .where('scopeMenu.deletedAt', 'is', null);
  const { ringGroupId, menuId } = exclude;
  if (ringGroupId !== undefined) {
    query = query.where(eb =>
      eb.or([
        eb('oooRules.scopeRingGroupId', 'is', null),
        eb('oooRules.scopeRingGroupId', '!=', ringGroupId)
      ])
    );
  }
  if (menuId !== undefined) {
    query = query.where(eb =>
      eb.or([
        eb('oooRules.scopeMenuId', 'is', null),
        eb('oooRules.scopeMenuId', '!=', menuId)
      ])
    );
  }
  return query.execute();
}

/** `opening_hours.closed_target_id` under the same scope rules as `loadScopedOooRules`. */
async function loadScopedOpeningHours(
  db: Db,
  ftIds: string[],
  exclude: OwnScope
): Promise<{ id: string }[]> {
  let query = db
    .selectFrom('openingHours')
    .leftJoin('users as scopeUser', 'scopeUser.id', 'openingHours.scopeUserId')
    .leftJoin(
      'ringGroups as scopeGroup',
      'scopeGroup.id',
      'openingHours.scopeRingGroupId'
    )
    .leftJoin('menus as scopeMenu', 'scopeMenu.id', 'openingHours.scopeMenuId')
    .select('openingHours.id as id')
    .where('openingHours.closedTargetId', 'in', ftIds)
    .where('openingHours.deletedAt', 'is', null)
    .where('scopeUser.deletedAt', 'is', null)
    .where('scopeGroup.deletedAt', 'is', null)
    .where('scopeMenu.deletedAt', 'is', null);
  const { ringGroupId, menuId } = exclude;
  if (ringGroupId !== undefined) {
    query = query.where(eb =>
      eb.or([
        eb('openingHours.scopeRingGroupId', 'is', null),
        eb('openingHours.scopeRingGroupId', '!=', ringGroupId)
      ])
    );
  }
  if (menuId !== undefined) {
    query = query.where(eb =>
      eb.or([
        eb('openingHours.scopeMenuId', 'is', null),
        eb('openingHours.scopeMenuId', '!=', menuId)
      ])
    );
  }
  return query.execute();
}

/**
 * The two schedule owners of a `forward_targets` row, `ooo_rules.target_id` and
 * `opening_hours.closed_target_id`, each outside `exclude`'s own scope (§5.9).
 */
export async function loadScheduleSources(
  db: Db,
  ftIds: string[],
  exclude: OwnScope
): Promise<ScheduleSources> {
  const [ooo, hours] = await Promise.all([
    loadScopedOooRules(db, ftIds, exclude),
    loadScopedOpeningHours(db, ftIds, exclude)
  ]);
  return { ooo, hours };
}
