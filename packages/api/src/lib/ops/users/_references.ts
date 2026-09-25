import type { Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import {
  findForwardTargetOwners,
  type Reference
} from '../forwardTargetOwners.js';

export type { Reference };

/** The `forward_targets` ids this user owns as a ring or mailbox target (§11.2). */
async function ownedForwardTargetIds(
  db: Transaction<DB>,
  userId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('forwardTargets')
    .select('id')
    .where(eb =>
      eb.or([eb('userId', '=', userId), eb('mailboxUserId', '=', userId)])
    )
    .execute();
  return rows.map(row => row.id);
}

/**
 * The ids of `userId`'s own `ooo_rules` and `opening_hours` rows (§5.9): a scope's own rules
 * travel with it rather than blocking its own delete. `findForwardTargetOwners` excludes a
 * ring group's or a menu's own scope through `OwnScope`, which has no user case, so this queries
 * the two scope columns directly instead.
 */
async function ownScopeRuleIds(
  db: Transaction<DB>,
  userId: string
): Promise<{ oooRuleIds: Set<string>; openingHoursIds: Set<string> }> {
  const [oooRows, hoursRows] = await Promise.all([
    db
      .selectFrom('oooRules')
      .select('id')
      .where('scopeUserId', '=', userId)
      .execute(),
    db
      .selectFrom('openingHours')
      .select('id')
      .where('scopeUserId', '=', userId)
      .execute()
  ]);
  return {
    oooRuleIds: new Set(oooRows.map(row => row.id)),
    openingHoursIds: new Set(hoursRows.map(row => row.id))
  };
}

/**
 * The blocking references a soft delete of user `userId` must list, or `[]` when free (§5.9).
 * `findForwardTargetOwners` has no user scope to exclude, so this filters out the cases that are
 * the user's own scope: their own forwarding rule pointing at their own target, and their own
 * OOO rules and opening-hours schedules, all deleted with them rather than blocking their delete.
 */
export async function findUserReferences(
  db: Transaction<DB>,
  userId: string
): Promise<Reference[]> {
  const ftIds = await ownedForwardTargetIds(db, userId);
  const [owners, ownScope] = await Promise.all([
    findForwardTargetOwners(db, ftIds),
    ownScopeRuleIds(db, userId)
  ]);
  return owners.filter(ref => {
    if (ref.kind === 'user' && ref.id === userId) {
      return false;
    }
    if (ref.kind === 'oooRule' && ownScope.oooRuleIds.has(ref.id)) {
      return false;
    }
    if (ref.kind === 'openingHours' && ownScope.openingHoursIds.has(ref.id)) {
      return false;
    }
    return true;
  });
}
