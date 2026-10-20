import { HTTP_CONFLICT, type ChangeEntry } from '@zamfono/shared';

import { replayOperation } from '../replay.js';
import { OpError, type Context } from '../types.js';
import { clearCallerIdSet } from './_callerId.js';

/**
 * Reverts one `dids.create` entry (§5.8): the caller ID the creation gave its target user goes
 * first, so the DID is no longer presented, then `dids.delete` removes it.
 */
export async function revertDidCreate(
  ctx: Context,
  didId: string,
  changes: ChangeEntry[]
): Promise<void> {
  await clearCallerIdSet(ctx, didId, changes);
  await replayOperation(ctx, 'dids.delete', { id: didId });
}

/**
 * Reverts one `dids.update` entry (§5.8): the caller ID the retarget gave its new user goes, and
 * the recorded `from` label and target go back through `dids.update`.
 */
export async function revertDidUpdate(
  ctx: Context,
  didId: string,
  changes: ChangeEntry[]
): Promise<void> {
  const input: Record<string, unknown> = { id: didId };
  for (const change of changes) {
    if (change.field === 'label' || change.field === 'target') {
      input[change.field] = change.from;
    }
  }
  if (Object.keys(input).length === 1) {
    throw new OpError(
      HTTP_CONFLICT,
      "audit.undo: the 'dids.update' entry records no 'label' or 'target'"
    );
  }
  await clearCallerIdSet(ctx, didId, changes);
  await replayOperation(ctx, 'dids.update', input);
}
