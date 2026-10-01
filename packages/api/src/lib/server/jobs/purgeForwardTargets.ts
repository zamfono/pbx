/**
 * `forward_targets` cleanup for the daily retention purge (§5.9 last paragraph): an
 * about-to-be-purged entity's own forward-rule rows, and the targets no row references any more.
 * `purge.ts` runs both inside its one transaction.
 */
import type { Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

/** One scope column, kept for the OR below only while its due-ids list is non-empty. */
type ScopeColumn = 'scopeMenuId' | 'scopeRingGroupId' | 'scopeUserId';

/**
 * Non-empty (column, ids) pairs across the three scope columns — an empty `ids` array would
 * compile its `in` clause as the invalid `in ()`, so a due-less scope contributes no pair.
 */
function dueScopes(
  dueUserIds: string[],
  dueRingGroupIds: string[],
  dueMenuIds: string[]
): [ScopeColumn, string[]][] {
  const scopes: [ScopeColumn, string[]][] = [
    ['scopeUserId', dueUserIds],
    ['scopeRingGroupId', dueRingGroupIds],
    ['scopeMenuId', dueMenuIds]
  ];
  return scopes.filter(([, ids]) => ids.length > 0);
}

/**
 * Removes the own forward-rule rows of an about-to-be-purged user, ring group or menu (§5.9
 * "an entity's own rules ... travel with it"): these are child rows of the entity rather than
 * independently soft-deleted, and a physical FK (`user_forward_rules.target_id`, etc.) blocks
 * deleting the `forward_targets` row they point at until they are gone — even one pointing back
 * at the entity's own mailbox, which would otherwise block the entity's own purge in turn.
 *
 * `ooo_rules` and `opening_hours` scoped to the entity are its own schedules by the same rule:
 * `scope_user_id`/`scope_ring_group_id`/`scope_menu_id` cascade when the entity row is deleted,
 * but a live (not independently soft-deleted) schedule's `target_id`/`closed_target_id` keeps its
 * `forward_targets` row — and, through it, the entity itself — referenced until the schedule row
 * is gone, so they are removed here too, before the orphan `forward_targets` sweep.
 */
export async function purgeOwnRuleRows(
  trx: Transaction<DB>,
  dueUserIds: string[],
  dueRingGroupIds: string[],
  dueMenuIds: string[]
): Promise<void> {
  if (dueUserIds.length > 0) {
    await trx
      .deleteFrom('userForwardRules')
      .where('userId', 'in', dueUserIds)
      .execute();
  }
  if (dueRingGroupIds.length > 0) {
    await trx
      .deleteFrom('ringGroupForwardRules')
      .where('groupId', 'in', dueRingGroupIds)
      .execute();
  }
  if (dueMenuIds.length > 0) {
    await trx
      .deleteFrom('menuTargets')
      .where('menuId', 'in', dueMenuIds)
      .execute();
  }
  const scopes = dueScopes(dueUserIds, dueRingGroupIds, dueMenuIds);
  if (scopes.length === 0) {
    return;
  }
  await trx
    .deleteFrom('oooRules')
    .where(eb => eb.or(scopes.map(([column, ids]) => eb(column, 'in', ids))))
    .execute();
  await trx
    .deleteFrom('openingHours')
    .where(eb => eb.or(scopes.map(([column, ids]) => eb(column, 'in', ids))))
    .execute();
}

/**
 * Every `forward_targets` id still named by one of §11.2's nine owner columns, regardless of the
 * owning row's own `deleted_at`: unlike `findForwardTargetOwners` (a live-delete refusal, which
 * counts only live owners), the physical FK a purge must respect blocks on any owning row that
 * still exists, deleted or not.
 */
async function referencedForwardTargetIds(
  trx: Transaction<DB>
): Promise<Set<string>> {
  const [
    dids,
    didBlocks,
    menus,
    menuTargets,
    userRules,
    groupRules,
    settingsRows,
    oooRules,
    openingHours
  ] = await Promise.all([
    trx.selectFrom('dids').select('targetId').execute(),
    trx
      .selectFrom('didBlocks')
      .select('fallbackTargetId')
      .where('fallbackTargetId', 'is not', null)
      .execute(),
    trx.selectFrom('menus').select('fallbackTargetId').execute(),
    trx.selectFrom('menuTargets').select('targetId').execute(),
    trx.selectFrom('userForwardRules').select('targetId').execute(),
    trx.selectFrom('ringGroupForwardRules').select('targetId').execute(),
    trx
      .selectFrom('settings')
      .select('fallbackTargetId')
      .where('fallbackTargetId', 'is not', null)
      .execute(),
    trx.selectFrom('oooRules').select('targetId').execute(),
    trx.selectFrom('openingHours').select('closedTargetId').execute()
  ]);
  const ids = new Set<string>();
  for (const row of dids) {
    ids.add(row.targetId);
  }
  for (const row of didBlocks) {
    if (row.fallbackTargetId !== null) {
      ids.add(row.fallbackTargetId);
    }
  }
  for (const row of menus) {
    ids.add(row.fallbackTargetId);
  }
  for (const row of menuTargets) {
    ids.add(row.targetId);
  }
  for (const row of userRules) {
    ids.add(row.targetId);
  }
  for (const row of groupRules) {
    ids.add(row.targetId);
  }
  for (const row of settingsRows) {
    if (row.fallbackTargetId !== null) {
      ids.add(row.fallbackTargetId);
    }
  }
  for (const row of oooRules) {
    ids.add(row.targetId);
  }
  for (const row of openingHours) {
    ids.add(row.closedTargetId);
  }
  return ids;
}

/** Hard-deletes every `forward_targets` row no owner column references any more (§5.9). */
export async function purgeOrphanForwardTargets(
  trx: Transaction<DB>
): Promise<void> {
  const [all, referenced] = await Promise.all([
    trx.selectFrom('forwardTargets').select('id').execute(),
    referencedForwardTargetIds(trx)
  ]);
  const orphanIds = all.map(row => row.id).filter(id => !referenced.has(id));
  if (orphanIds.length > 0) {
    await trx
      .deleteFrom('forwardTargets')
      .where('id', 'in', orphanIds)
      .execute();
  }
}
