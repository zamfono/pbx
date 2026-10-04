import { isE164, type ChangeEntry } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { replayOperation } from '../runner.js';
import type { Context } from '../types.js';

/** The audit field naming the caller ID a DID write set on its target user. */
const CALLER_ID_FIELD = 'callerIdDidId';

/**
 * Sets a user's caller-ID DID the first time they receive one (§9.4 "Caller-ID"): a user target
 * that so far presents no number of their own gets this DID as `users.caller_id_did_id`.
 */
export async function setCallerIdIfUnset(
  ctx: Context,
  userId: string,
  didId: string,
  number: string
): Promise<void> {
  const user = await ctx.db
    .selectFrom('users')
    .select('callerIdDidId')
    .where('id', '=', userId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (user?.callerIdDidId === null && isE164(number)) {
    await ctx.db
      .updateTable('users')
      .set({ callerIdDidId: didId })
      .where('id', '=', userId)
      .execute();
    recordChange(ctx, { field: CALLER_ID_FIELD, from: null, to: didId });
  }
}

/**
 * Undoes what `setCallerIdIfUnset` recorded in `changes` (§5.8): the DID's target user, while
 * still live and still presenting this DID, goes back to no caller ID of their own, through
 * `users.update`. The DID's target is the one the reverted entry wrote, since undo refuses any
 * later change to the DID.
 */
export async function clearCallerIdSet(
  ctx: Context,
  didId: string,
  changes: ChangeEntry[]
): Promise<void> {
  if (!changes.some(change => change.field === CALLER_ID_FIELD)) {
    return;
  }
  const user = await ctx.db
    .selectFrom('dids')
    .innerJoin('forwardTargets', 'forwardTargets.id', 'dids.targetId')
    .innerJoin('users', 'users.id', 'forwardTargets.userId')
    .select('users.id')
    .where('dids.id', '=', didId)
    .where('users.callerIdDidId', '=', didId)
    .where('users.deletedAt', 'is', null)
    .executeTakeFirst();
  if (user) {
    await replayOperation(ctx, 'users.update', {
      id: user.id,
      callerIdDidId: null
    });
  }
}
