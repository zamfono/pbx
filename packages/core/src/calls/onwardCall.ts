/**
 * The transferee's own new call (§10.1 "Transfers and pickup"): whoever a transfer, or the
 * parking ring-back's fallback (§10.2 "Call parking"), hands on goes on in a call of their own
 * linked to the original through `parent_call_id`. `transfers.ts` starts it for the transfers
 * `api` requests, `parkingRingback.ts` for a parked party, and `blindTransfer.ts` gives a `REFER`
 * transfer's onward call the same identity.
 */
import { newId } from '@zamfono/shared';

import { logFailure } from '../ari/failures.js';
import type { LogLevel } from '../callLog.js';
import type { Snapshot } from '../internal/snapshot.js';
import { setChannelLanguage } from '../prompts.js';
import { newCall, type Call } from './call.js';
import { raiseLogLevel } from './callLogLevel.js';
import { presentCallerUserId } from './callLookup.js';
import { extensionOf } from './extensionOwner.js';
import type { Pipeline } from './pipeline.js';

/** The user present in `call` as `channelId`: its caller, or the leg's owner. */
export function userOfChannel(call: Call, channelId: string): string | null {
  if (channelId === call.callerChannelId) {
    return presentCallerUserId(call);
  }
  return call.legs.get(channelId)?.userId ?? null;
}

/** The number the transferee's new call is from: the original caller's, a colleague's extension,
 * else, for a party with no user of its own (an external number dialled), the number the call
 * went to. */
export function fromOf(
  parent: Call,
  transferee: string,
  snapshot: Snapshot
): string {
  if (transferee === parent.callerChannelId) {
    return parent.from;
  }
  const userId = userOfChannel(parent, transferee);
  const ext = userId === null ? null : extensionOf(snapshot, { userId });
  return ext ?? parent.to;
}

/**
 * What the transferee's new call inherits from `parent` (§10.1 "Transfers and pickup"): the
 * original caller of an inbound call stays an inbound caller, reaching the target through the
 * company's number, so opening hours, the missed-call mail and the history's direction filter
 * treat the onward call as the inbound call it continues; anyone else starts afresh.
 */
export function transfereeEntry(
  parent: Call,
  transferee: string
): { inbound: boolean; didId: string | null } {
  const isOriginalCaller = transferee === parent.callerChannelId;
  return {
    inbound: isOriginalCaller && parent.direction === 'inbound',
    didId: isOriginalCaller ? parent.didId : null
  };
}

/** What an onward call is, beside its parent and transferee: the number it goes `to`, its
 * direction unless it continues an inbound call (`transfereeEntry`), its trace level, the user it
 * is routed as, whose diagnostics override counts toward that level (§7), and what its `entry`
 * trace line says of where it goes. */
export type OnwardEntry = {
  to: string;
  direction: Call['direction'];
  logLevel: LogLevel;
  asUserId: string | null;
  trace: Record<string, unknown>;
};

/**
 * Starts the transferee's own new call: `parent_call_id` links it to `parent`, its caller channel
 * is the transferee's, and `route` sends it on, running after this returns like any other call's
 * routing.
 */
export async function startOnwardCall(
  pipeline: Pipeline,
  parent: Call,
  transferee: string,
  onward: { snapshot: Snapshot; entry: OnwardEntry },
  route: (child: Call) => Promise<void>
): Promise<Call> {
  const { snapshot, entry } = onward;
  const inherited = transfereeEntry(parent, transferee);
  const startedAt = pipeline.deps.now();
  const child = newCall({
    id: newId(),
    direction: inherited.inbound ? 'inbound' : entry.direction,
    callerChannelId: transferee,
    from: fromOf(parent, transferee, snapshot),
    to: entry.to,
    startedAt,
    logLevel: entry.logLevel,
    callLogMaxBytes: pipeline.deps.callLogMaxBytes
  });
  child.parentCallId = parent.id;
  child.callerUserId = userOfChannel(parent, transferee);
  child.didId = inherited.didId;
  raiseLogLevel(
    child.log,
    snapshot.users.find(row => row.id === entry.asUserId),
    startedAt
  );
  await pipeline.deps.cdr.open(child);
  pipeline.registerCall(child);
  // §9.1: every channel's language is the tenant's; the transferee may be a leg the core
  // originated, which has not been through an entry of its own.
  await setChannelLanguage(
    pipeline.deps.ari,
    transferee,
    snapshot.settings.language
  );
  child.log.event({ event: 'entry', ...entry.trace, parentCallId: parent.id });
  route(child).catch(
    logFailure(pipeline.deps.logger, 'onward routing', { callId: child.id })
  );
  return child;
}
