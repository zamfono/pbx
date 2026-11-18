import { sql } from 'kysely';

import type { Db } from '@zamfono/shared';

import {
  loadScheduleSources,
  type ScheduleSources
} from './forwardTargetScheduleOwners.js';

/** One entry of §5.9's blocking-reference list, as a delete refusal carries it. */
export type Reference = { kind: string; id: string; label: string };

/**
 * The entity whose own rules travel with it rather than blocking its own delete (§5.9): a ring
 * group's, a menu's or a decision's own scope is excluded from the owners `findForwardTargetOwners`
 * reports.
 */
export type OwnScope = {
  ringGroupId?: string;
  menuId?: string;
  decisionId?: string;
};

type UnscopedSources = {
  dids: { id: string; label: string | null; number: string }[];
  didBlocks: { id: string; label: string | null; base: string }[];
  settingsRows: { id: number | null }[];
  userRules: { userId: string; condition: string }[];
};

/**
 * The four `forward_targets` owners no entity ever excludes its own scope from: `dids.target_id`,
 * `did_blocks.fallback_target_id`, `settings.fallback_target_id` and `user_forward_rules.target_id`
 * (a user's own rule is never another entity's own scope). Each is filtered on its own
 * `deleted_at`, or its owning user's; `settings` has no `deleted_at` (a single tenant-wide row).
 */
async function loadUnscopedSources(
  db: Db,
  ftIds: string[]
): Promise<UnscopedSources> {
  const [dids, didBlocks, settingsRows, userRules] = await Promise.all([
    db
      .selectFrom('dids')
      .select(['id', 'label', 'number'])
      .where('targetId', 'in', ftIds)
      .where('deletedAt', 'is', null)
      .execute(),
    db
      .selectFrom('didBlocks')
      .select(['id', 'label', 'base'])
      .where('fallbackTargetId', 'in', ftIds)
      .where('deletedAt', 'is', null)
      .execute(),
    db
      .selectFrom('settings')
      .select('id')
      .where('fallbackTargetId', 'in', ftIds)
      .execute(),
    db
      .selectFrom('userForwardRules')
      .innerJoin('users', 'users.id', 'userForwardRules.userId')
      .select([
        'userForwardRules.userId as userId',
        'userForwardRules.condition as condition'
      ])
      .where('userForwardRules.targetId', 'in', ftIds)
      .where('users.deletedAt', 'is', null)
      .execute()
  ]);
  return { dids, didBlocks, settingsRows, userRules };
}

type MenuOwnedSources = {
  menus: { id: string; name: string }[];
  menuTargets: { menuId: string; digits: string }[];
};

/**
 * `menus.fallback_target_id` and `menu_targets.target_id`, outside `menuId`'s own scope: a menu's
 * own fallback and DTMF options travel with it (§5.9) rather than blocking its own delete.
 */
async function loadMenuOwnedSources(
  db: Db,
  ftIds: string[],
  menuId: string | undefined
): Promise<MenuOwnedSources> {
  let menus = db
    .selectFrom('menus')
    .select(['id', 'name'])
    .where('fallbackTargetId', 'in', ftIds)
    .where('deletedAt', 'is', null);
  let menuTargets = db
    .selectFrom('menuTargets')
    .innerJoin('menus', 'menus.id', 'menuTargets.menuId')
    .select(['menuTargets.menuId as menuId', 'menuTargets.digits as digits'])
    .where('menuTargets.targetId', 'in', ftIds)
    .where('menus.deletedAt', 'is', null);
  if (menuId !== undefined) {
    menus = menus.where('id', '!=', menuId);
    menuTargets = menuTargets.where('menuTargets.menuId', '!=', menuId);
  }
  const [menuRows, menuTargetRows] = await Promise.all([
    menus.execute(),
    menuTargets.execute()
  ]);
  return { menus: menuRows, menuTargets: menuTargetRows };
}

/**
 * `ring_group_forward_rules.target_id`, outside `ringGroupId`'s own scope: a group's own rules
 * travel with it (§5.9) rather than blocking its own delete.
 */
async function loadRingGroupOwnedSources(
  db: Db,
  ftIds: string[],
  ringGroupId: string | undefined
): Promise<{ groupId: string; condition: string }[]> {
  const query = db
    .selectFrom('ringGroupForwardRules')
    .innerJoin('ringGroups', 'ringGroups.id', 'ringGroupForwardRules.groupId')
    .select([
      'ringGroupForwardRules.groupId as groupId',
      'ringGroupForwardRules.condition as condition'
    ])
    .where('ringGroupForwardRules.targetId', 'in', ftIds)
    .where('ringGroups.deletedAt', 'is', null);
  return ringGroupId === undefined
    ? query.execute()
    : query.where('ringGroupForwardRules.groupId', '!=', ringGroupId).execute();
}

type DecisionOwnedSources = {
  decisions: { id: string; name: string }[];
  cases: { decisionId: string; name: string; position: number }[];
};

/**
 * `decisions.default_target_id` and `decision_cases.target_id`, outside `decisionId`'s own scope: a
 * decision's own default and cases travel with it (§5.9) rather than blocking its own delete.
 */
async function loadDecisionOwnedSources(
  db: Db,
  ftIds: string[],
  decisionId: string | undefined
): Promise<DecisionOwnedSources> {
  let decisions = db
    .selectFrom('decisions')
    .select(['id', 'name'])
    .where('defaultTargetId', 'in', ftIds)
    .where('deletedAt', 'is', null);
  let cases = db
    .selectFrom('decisionCases')
    .innerJoin('decisions', 'decisions.id', 'decisionCases.decisionId')
    .select([
      'decisionCases.decisionId as decisionId',
      'decisions.name as name',
      'decisionCases.position as position'
    ])
    .where('decisionCases.targetId', 'in', ftIds)
    .where('decisions.deletedAt', 'is', null);
  if (decisionId !== undefined) {
    decisions = decisions.where('id', '!=', decisionId);
    cases = cases.where('decisionCases.decisionId', '!=', decisionId);
  }
  const [decisionRows, caseRows] = await Promise.all([
    decisions.execute(),
    cases.execute()
  ]);
  return { decisions: decisionRows, cases: caseRows };
}

/** Flattens every §5.9 reference source into the wire shape a delete refusal carries. */
function toReferences(
  unscoped: UnscopedSources,
  menuOwned: MenuOwnedSources,
  decisionOwned: DecisionOwnedSources,
  groupRules: { groupId: string; condition: string }[],
  schedules: ScheduleSources
): Reference[] {
  return [
    ...unscoped.dids.map(row => ({
      kind: 'did',
      id: row.id,
      label: row.label ?? row.number
    })),
    ...unscoped.didBlocks.map(row => ({
      kind: 'didBlock',
      id: row.id,
      label: row.label ?? row.base
    })),
    ...unscoped.settingsRows.map(() => ({
      kind: 'settings',
      id: 'tenant',
      label: 'tenant fallback target'
    })),
    ...unscoped.userRules.map(row => ({
      kind: 'user',
      id: row.userId,
      label: `forwarding rule (${row.condition})`
    })),
    ...menuOwned.menus.map(row => ({
      kind: 'menu',
      id: row.id,
      label: row.name
    })),
    ...menuOwned.menuTargets.map(row => ({
      kind: 'menu',
      id: row.menuId,
      label: `menu option (${row.digits})`
    })),
    ...decisionOwned.decisions.map(row => ({
      kind: 'decision',
      id: row.id,
      label: `${row.name} (default)`
    })),
    ...decisionOwned.cases.map(row => ({
      kind: 'decision',
      id: row.decisionId,
      label: `${row.name} (case ${row.position + 1})`
    })),
    ...groupRules.map(row => ({
      kind: 'ringGroup',
      id: row.groupId,
      label: `forwarding rule (${row.condition})`
    })),
    ...schedules.ooo.map(row => ({
      kind: 'oooRule',
      id: row.id,
      label: 'out-of-office rule'
    })),
    ...schedules.hours.map(row => ({
      kind: 'openingHours',
      id: row.id,
      label: 'opening-hours schedule'
    }))
  ];
}

/**
 * The first row of the fallback chain each of `ftIds` is in (§10.1 step 7): a fallback has no
 * owner column of its own, its chain's first row has, so it is referenced through that row.
 */
async function chainHeads(db: Db, ftIds: string[]): Promise<string[]> {
  const ids = sql.join(ftIds.map(id => sql`${id}`));
  const { rows } = await sql<{ id: string }>`
    WITH RECURSIVE chain(id, fallback_of_id) AS (
      SELECT id, fallback_of_id FROM forward_targets WHERE id IN (${ids})
      UNION
      SELECT parent.id, parent.fallback_of_id
        FROM forward_targets parent JOIN chain ON parent.id = chain.fallback_of_id
    )
    SELECT id FROM chain WHERE fallback_of_id IS NULL`.execute(db);
  return rows.map(row => row.id);
}

/**
 * Every row across all eleven `forward_targets` owner columns of §11.2 that still points at one of
 * `ftIds`, outside `exclude`'s own scope: `dids.target_id`, `did_blocks.fallback_target_id`,
 * `menus.fallback_target_id`, `menu_targets.target_id`, `decisions.default_target_id`,
 * `decision_cases.target_id`, `user_forward_rules.target_id`,
 * `ring_group_forward_rules.target_id`, `settings.fallback_target_id`, `ooo_rules.target_id` and
 * `opening_hours.closed_target_id` (§5.9: a soft delete is refused while any of these exist); a
 * fallback is referenced by the owner of its chain's first row (`chainHeads`).
 */
export async function findForwardTargetOwners(
  db: Db,
  targetIds: string[],
  exclude: OwnScope = {}
): Promise<Reference[]> {
  if (targetIds.length === 0) {
    return [];
  }
  const ftIds = await chainHeads(db, targetIds);
  const [unscoped, menuOwned, decisionOwned, groupRules, schedules] =
    await Promise.all([
      loadUnscopedSources(db, ftIds),
      loadMenuOwnedSources(db, ftIds, exclude.menuId),
      loadDecisionOwnedSources(db, ftIds, exclude.decisionId),
      loadRingGroupOwnedSources(db, ftIds, exclude.ringGroupId),
      loadScheduleSources(db, ftIds, exclude)
    ]);
  return toReferences(
    unscoped,
    menuOwned,
    decisionOwned,
    groupRules,
    schedules
  );
}
