import { HTTP_CONFLICT, type ChangeEntry } from '@zamfono/shared';

import { revertBlfKeys } from '../audit/_cascadeRevert.js';
import type { DroppedBlfKey } from '../devices/_shared.js';
import { replayOperation } from '../replay.js';
import { OpError, type Context } from '../types.js';

/**
 * Reverts one `parking.set` entry (§5.8, §11.1 "extensions": parking-slot rows are "replaced as a
 * set by `PUT /parking/slots` and restored from the audit diff"): the recorded `from` set goes
 * back through `parking.set`, which refuses a slot another extension has taken since with a 409,
 * and the BLF keys the removal of a slot dropped through the FK are re-inserted once their slot
 * is back.
 */
export async function revertParkingSet(
  ctx: Context,
  _entityId: string,
  changes: ChangeEntry[]
): Promise<void> {
  const slots = changes.find(change => change.field === 'slots');
  if (!slots) {
    throw new OpError(
      HTTP_CONFLICT,
      "audit.undo: the 'parking.set' entry records no 'slots'"
    );
  }
  await replayOperation(ctx, 'parking.set', { slots: slots.from });
  const dropped = changes.find(change => change.field === 'droppedBlfKeys');
  if (dropped) {
    await revertBlfKeys(ctx, dropped.from as DroppedBlfKey[]);
  }
}
