import type { Db } from '@zamfono/shared';

import {
  findForwardTargetOwners,
  type Reference
} from '../forwardTargetOwners.js';

export type { Reference };

/**
 * The `forward_targets` ids this menu owns as a menu target (§11.2): one per DID, rule or menu
 * option that dials it, since each such reference owns its own row.
 */
async function ownedForwardTargetIds(
  db: Db,
  menuId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('forwardTargets')
    .select('id')
    .where('menuId', '=', menuId)
    .execute();
  return rows.map(row => row.id);
}

/** The blocking references a soft delete of menu `menuId` must list, or `[]` when free (§5.9). */
export async function findMenuReferences(
  db: Db,
  menuId: string
): Promise<Reference[]> {
  const ftIds = await ownedForwardTargetIds(db, menuId);
  return findForwardTargetOwners(db, ftIds, { menuId });
}
