import type { Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

/** The out-of-office rules and opening-hours schedules still pointing at one of the targets. */
export type ScheduleSources = {
  ooo: { id: string }[];
  hours: { id: string }[];
};

/**
 * `ooo_rules.target_id`, outside `ringGroupId`'s and `menuId`'s own scope and outside every
 * soft-deleted scope, whose rules travel with it (§5.9). A left join leaves the scope's
 * `deleted_at` NULL wherever the scope column is NULL, which keeps the tenant-wide rows in.
 */
async function loadScopedOooRules(
  db: Transaction<DB>,
  ftIds: string[],
  ringGroupId: string,
  menuId: string
): Promise<{ id: string }[]> {
  return db
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
    .where('scopeMenu.deletedAt', 'is', null)
    .where(eb =>
      eb.or([
        eb('oooRules.scopeRingGroupId', 'is', null),
        eb('oooRules.scopeRingGroupId', '!=', ringGroupId)
      ])
    )
    .where(eb =>
      eb.or([
        eb('oooRules.scopeMenuId', 'is', null),
        eb('oooRules.scopeMenuId', '!=', menuId)
      ])
    )
    .execute();
}

/** `opening_hours.closed_target_id` under the same scope rules as `loadScopedOooRules`. */
async function loadScopedOpeningHours(
  db: Transaction<DB>,
  ftIds: string[],
  ringGroupId: string,
  menuId: string
): Promise<{ id: string }[]> {
  return db
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
    .where('scopeMenu.deletedAt', 'is', null)
    .where(eb =>
      eb.or([
        eb('openingHours.scopeRingGroupId', 'is', null),
        eb('openingHours.scopeRingGroupId', '!=', ringGroupId)
      ])
    )
    .where(eb =>
      eb.or([
        eb('openingHours.scopeMenuId', 'is', null),
        eb('openingHours.scopeMenuId', '!=', menuId)
      ])
    )
    .execute();
}

/**
 * The two schedule owners of a `forward_targets` row, `ooo_rules.target_id` and
 * `opening_hours.closed_target_id`, each outside `ringGroupId`'s and `menuId`'s own scope (§5.9).
 */
export async function loadScheduleSources(
  db: Transaction<DB>,
  ftIds: string[],
  ringGroupId: string,
  menuId: string
): Promise<ScheduleSources> {
  const [ooo, hours] = await Promise.all([
    loadScopedOooRules(db, ftIds, ringGroupId, menuId),
    loadScopedOpeningHours(db, ftIds, ringGroupId, menuId)
  ]);
  return { ooo, hours };
}
