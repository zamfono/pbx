import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { Db, DB } from '@zamfono/shared';

import { targetSpecSchema } from '../forwardTargetSchema.js';
import { liveRow } from '../rows.js';

export type DidBlockRow = Selectable<DB['didBlocks']>;

/** A block's two kinds (§11.3), the same field on create and update. */
export const DIGITS_SCHEMA = z
  .number()
  .int()
  .positive()
  .nullable()
  .optional()
  .describe(
    'How many digits follow the base, e.g. 2 for +498912347xx; null or left out: any number of digits, none included (open-ended).'
  );

/** A block's own fallback (§11.3), for its numbers that no `dids` row holds. */
export const FALLBACK_TARGET_SCHEMA = targetSpecSchema
  .nullable()
  .optional()
  .describe(
    'Where a call for a number in the block that no DID holds goes; null: the tenant-wide settings.fallbackTarget, else 404. The digits behind the base are never read as an extension.'
  );

/** The live `did_blocks` row with `id`, or `OpError(404)`. */
export async function liveDidBlock(db: Db, id: string): Promise<DidBlockRow> {
  return liveRow(db, 'didBlocks', id, 'didBlocks: block not found');
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
