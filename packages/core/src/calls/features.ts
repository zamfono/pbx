/** Feature-code dispatch (§9.3 "Feature codes"; §10.1 "Transfers and pickup"; §10.2
 * "Three-way calls"). Mailbox DTMF access lives in `mailbox.ts`, call parking in `parking.ts`,
 * pickup in `pickup.ts` and `*5` in `addParty.ts`. */
import type { FeatureCodeKey } from '@zamfono/shared';

import type { Presence } from '../presence.js';
import { addParty } from './addParty.js';
import { release, type Call } from './call.js';
import { ownerForExt } from './extensionOwner.js';
import {
  concludeFeature,
  RELEASE_CODE_FORBIDDEN,
  RELEASE_CODE_NOT_FOUND
} from './featureCall.js';
import { mailboxAccess, ownVoicemail } from './mailbox.js';
import { park } from './parking.js';
import { pickupByExtension } from './pickup.js';
import type { Pipeline } from './pipeline.js';
import { deposit } from './voicemail.js';

/** `*90`/`*91`: writes `users.dnd` and refreshes the caller's own hint (§9.3, §3.1 cross-write). */
async function setDnd(
  pipeline: Pipeline,
  presence: Presence,
  call: Call,
  dnd: boolean
): Promise<void> {
  const db = pipeline.deps.db;
  if (call.callerUserId === null || db === undefined) {
    await release(pipeline, call, RELEASE_CODE_FORBIDDEN, 'failed');
    return;
  }
  await db
    .updateTable('users')
    .set({ dnd: dnd ? 1 : 0 })
    .where('id', '=', call.callerUserId)
    .execute();
  // Core's own cross-write (§3.1) reaches no `/internal/configChanged`; `refreshUser` derives the
  // hint and status from the config snapshot, so it must reload after this write.
  pipeline.deps.cache.invalidate();
  await presence.refreshUser(call.callerUserId);
  await concludeFeature(pipeline, call, 'answered');
}

/** `*97<ext>`: deposits the caller in `ext`'s mailbox without ringing (§9.3), through
 * `deposit()`. */
async function depositFeature(
  pipeline: Pipeline,
  call: Call,
  ext: string
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const owner = ownerForExt(snapshot, ext);
  if (owner === null) {
    await release(pipeline, call, RELEASE_CODE_NOT_FOUND, 'failed');
    return;
  }
  await deposit(pipeline, call, owner, 'feature');
}

/** Dispatches one feature-code dial (§9.3 table); unimplemented and unreachable keys share one refusal. */
export async function handleFeature(
  pipeline: Pipeline,
  presence: Presence,
  call: Call,
  key: FeatureCodeKey,
  rest: string
): Promise<void> {
  const actions: Partial<Record<FeatureCodeKey, () => Promise<void>>> = {
    pickup: () => pickupByExtension(pipeline, call, rest),
    dndOn: () => setDnd(pipeline, presence, call, true),
    dndOff: () => setDnd(pipeline, presence, call, false),
    mailbox: () => mailboxAccess(pipeline, call, rest),
    ownVoicemail: () => ownVoicemail(pipeline, call),
    deposit: () => depositFeature(pipeline, call, rest),
    addParty: () => addParty(pipeline, call, rest),
    park: () => park(pipeline, presence, call)
  };
  const action = actions[key];
  if (action === undefined) {
    await release(pipeline, call, RELEASE_CODE_NOT_FOUND, 'failed');
    return;
  }
  await action();
}
