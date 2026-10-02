/**
 * "Outbound" (spec §10.1 steps 1-6; §9.4 "Outbound routing"): resolves a dialled string from a
 * registered client (§9.2 `outbound,<exten>`). Dispatching the resolved string is
 * `outboundDispatch.ts`'s; an external number's trunk, caller-ID, host failover and route
 * fallthrough (§9.4) are `outboundExternal.ts`'s and `dialAttempt.ts`'s, emergency is `emergency.ts`.
 */
import { newId } from '@zamfono/shared';

import type { AriEvent, Channel } from '../ari/types.js';
import { setChannelLanguage } from '../prompts.js';
import type { DialAction } from '../routing/outbound.js';
import { newCall, type Call } from './call.js';
import { raiseLogLevel } from './callLogLevel.js';
import {
  dispatchAction,
  logLevelFor,
  resolveTarget
} from './outboundDispatch.js';
import { identifyCallerUserId } from './outboundLookup.js';
import { takePendingTransfer } from './pendingTransfer.js';
import type { Pipeline } from './pipeline.js';

/** §9.3 "a user: ... INUSE in a call": the dialling user's own device is in a call from the
 * moment it dials a colleague, a group, a number or a parking slot, whatever the far end does
 * next. Keyed by `call.id`, so `legsEnded.ts`'s `clearParticipantPresence` releases it when this
 * call ends. A feature-code dial or a refused string is no call of the user's. */
function markCallerInCall(
  pipeline: Pipeline,
  call: Call,
  action: DialAction
): void {
  if (
    call.callerUserId === null ||
    action.kind === 'feature' ||
    action.kind === 'refuse'
  ) {
    return;
  }
  pipeline.deps.presence.setCallState(
    call.callerUserId,
    'inCall',
    call.to,
    null,
    call.id
  );
}

/** `outbound,<exten>` Stasis entry (§9.2): resolves the dialled string and dispatches it. */
export async function handleOutbound(
  pipeline: Pipeline,
  ev: AriEvent
): Promise<void> {
  const channel = ev.channel as Channel;
  const args = (ev.args as string[] | undefined) ?? [];
  const dialed = args[1] ?? '';
  const snapshot = await pipeline.deps.cache.get();
  const { action, direction, to } = resolveTarget(snapshot, dialed);
  // §10.1 "Transfers and pickup": a blind transfer's onward call is routed as the transferrer's,
  // so the identity it dials as, its caller, its parent and, for an inbound caller, its inbound
  // direction and DID come from the transfer rather than from this channel, which may be the
  // Local channel Asterisk dials the target through.
  const transfer = await takePendingTransfer(pipeline, channel);
  const call = newCall({
    id: newId(),
    direction: transfer?.inbound === true ? 'inbound' : direction,
    callerChannelId: channel.id,
    from: transfer?.from ?? channel.caller.number,
    to,
    startedAt: pipeline.deps.now(),
    logLevel: logLevelFor(snapshot, action, pipeline.deps.now()),
    callLogMaxBytes: pipeline.deps.callLogMaxBytes
  });
  call.callerUserId =
    transfer === null
      ? identifyCallerUserId(channel, snapshot)
      : transfer.transfereeUserId;
  call.parentCallId = transfer?.parentCallId ?? null;
  call.didId = transfer?.didId ?? null;
  const asUser =
    transfer === null ? call.callerUserId : transfer.transferrerUserId;
  // §7: the call is routed as `asUser`'s, so their diagnostics override counts toward its level.
  raiseLogLevel(
    call.log,
    snapshot.users.find(row => row.id === asUser),
    pipeline.deps.now()
  );
  await pipeline.deps.cdr.open(call);
  pipeline.registerCall(call);
  // §9.1: every channel's language is the tenant's, so the prompts this call plays follow it.
  await setChannelLanguage(
    pipeline.deps.ari,
    channel.id,
    snapshot.settings.language
  );
  if (transfer !== null) {
    call.log.event({
      event: 'transferredFrom',
      parentCallId: transfer.parentCallId
    });
  }
  call.log.event({ event: 'entry', dialAction: action.kind, dialed });
  markCallerInCall(pipeline, call, action);

  await dispatchAction(pipeline, call, action, { snapshot, asUser });
}
