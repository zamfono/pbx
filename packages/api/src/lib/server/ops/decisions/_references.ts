import type { Db } from '@zamfono/shared';

import {
  findForwardTargetOwners,
  type Reference
} from '../forwardTargetOwners.js';

/**
 * The blocking references a soft delete of decision `decisionId` must list, or `[]` when free
 * (§5.9): every rule, number, menu or other decision whose target names it; its own cases and
 * default naming it travel with it.
 */
export async function findDecisionReferences(
  db: Db,
  decisionId: string
): Promise<Reference[]> {
  const rows = await db
    .selectFrom('forwardTargets')
    .select('id')
    .where('decisionId', '=', decisionId)
    .execute();
  return findForwardTargetOwners(
    db,
    rows.map(row => row.id),
    { decisionId }
  );
}
