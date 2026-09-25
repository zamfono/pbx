import type { Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import {
  findForwardTargetOwners,
  type Reference
} from '../forwardTargetOwners.js';

export type { Reference };

/** The `forward_targets` ids this ring group owns as a ring or mailbox target (§11.2). */
async function ownedForwardTargetIds(
  db: Transaction<DB>,
  groupId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('forwardTargets')
    .select('id')
    .where(eb =>
      eb.or([
        eb('ringGroupId', '=', groupId),
        eb('mailboxRingGroupId', '=', groupId)
      ])
    )
    .execute();
  return rows.map(row => row.id);
}

/** The blocking references a soft delete of ring group `groupId` must list, or `[]` when free (§5.9). */
export async function findRingGroupReferences(
  db: Transaction<DB>,
  groupId: string
): Promise<Reference[]> {
  const ftIds = await ownedForwardTargetIds(db, groupId);
  return findForwardTargetOwners(db, ftIds, { ringGroupId: groupId });
}
