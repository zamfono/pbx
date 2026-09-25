import type { Selectable } from 'kysely';

import type { Db, DB } from '@zamfono/shared';

export type DidBlockRow = Selectable<DB['didBlocks']>;

/** Loads a live `did_blocks` row by id, or `undefined` when absent or soft-deleted. */
export async function loadLiveDidBlock(
  db: Db,
  id: string
): Promise<DidBlockRow | undefined> {
  return db
    .selectFrom('didBlocks')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}

/**
 * Live DIDs within `block` (§11.3): a number begins with its base and, for a digits block, has
 * exactly `base.length + digits` characters. Mirrors the `did_blocks_soft_delete_guard` trigger.
 */
export async function liveDidsInBlock(
  db: Db,
  block: Pick<DidBlockRow, 'base' | 'digits'>
): Promise<{ id: string; number: string }[]> {
  const dids = await db
    .selectFrom('dids')
    .select(['id', 'number'])
    .where('deletedAt', 'is', null)
    .execute();
  return dids.filter(
    did =>
      did.number.startsWith(block.base) &&
      (block.digits === null ||
        did.number.length === block.base.length + block.digits)
  );
}
