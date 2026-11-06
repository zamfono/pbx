/** Terminal failures of an outbound or emergency dial: the releases of §9.4 "Route fallthrough" /
 * "Outbound routing" once a route (or the trunk list) is done. An answer settles in `answer.ts`. */
import { ignoreGone } from '../ari/failures.js';
import { defaultPrompt } from '../prompts.js';
import type { AttemptFailure } from '../routing/trunk.js';
import {
  SIP_BUSY_EVERYWHERE,
  SIP_BUSY_HERE,
  SIP_DECLINE,
  SIP_FORBIDDEN,
  SIP_SERVICE_UNAVAILABLE,
  SIP_TEMPORARILY_UNAVAILABLE
} from '../sipCodes.js';
import { type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { release } from './release.js';

const CALLEE_BUSY_CODES = new Set<number>([
  SIP_BUSY_HERE,
  SIP_BUSY_EVERYWHERE,
  SIP_DECLINE
]);

/** `calls.status` for a final, non-fallthrough failure (§10.1, §11.2): 480 missed, else busy-family. */
function statusForFinalCode(code: number): 'missed' | 'busy' {
  if (code === SIP_TEMPORARILY_UNAVAILABLE) {
    return 'missed';
  }
  return CALLEE_BUSY_CODES.has(code) ? 'busy' : 'missed';
}

export async function concludeFinal(
  pipeline: Pipeline,
  call: Call,
  failure: AttemptFailure
): Promise<void> {
  if (failure.kind === 'ringTimeout') {
    // §10.1 step 7: a target that rang out without a fallback ends unanswered.
    await release(pipeline, call, SIP_TEMPORARILY_UNAVAILABLE, 'missed');
    return;
  }
  if (failure.kind !== 'final') {
    return;
  }
  await release(pipeline, call, failure.code, statusForFinalCode(failure.code));
}

/** Answers and plays the failed-call announcement to completion (§9.4 "Cross-trunk failover"), in
 * the channel's language, the same answer-then-play order `announce.ts` uses, since a playback
 * reaches no unanswered caller. A call with no caller channel (a party `api` adds) has nobody to
 * play to. */
async function playFailedCallAnnouncement(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  const channelId = call.callerChannelId;
  if (channelId === null) {
    return;
  }
  await pipeline.deps.ari.channels.answer(channelId).catch(ignoreGone);
  await playAndWait(
    pipeline.deps.ari,
    channelId,
    defaultPrompt('failedCall'),
    `${channelId}:failed`
  );
}

/** The route list exhausted (§9.4 "Outbound routing"): 486 for a capped route, 403 for CLIR, else
 * 503 with the failed-call announcement (§9.4 "Cross-trunk failover"). `null` means no route
 * matched at all, which no route failed for: "refused with 503 and logged at level `events`",
 * unanswered and with no announcement. */
export async function concludeExhausted(
  pipeline: Pipeline,
  call: Call,
  lastFailureKind: AttemptFailure['kind'] | null
): Promise<void> {
  if (lastFailureKind === null) {
    call.log.event({ event: 'noRoute' });
    await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
    return;
  }
  if (lastFailureKind === 'cap') {
    await release(pipeline, call, SIP_BUSY_HERE, 'busy');
    return;
  }
  if (lastFailureKind === 'clirUnsupported') {
    await release(pipeline, call, SIP_FORBIDDEN, 'failed');
    return;
  }
  await playFailedCallAnnouncement(pipeline, call);
  await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
}
