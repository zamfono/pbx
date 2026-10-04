/** Terminal failures of an outbound or emergency dial: the releases of §9.4 "Route fallthrough" /
 * "Outbound routing" once a route (or the trunk list) is done. An answer settles in `answer.ts`. */
import { ignoreGone } from '../ari/failures.js';
import {
  SIT_DURATION_MS,
  SPECIAL_INFORMATION_TONE_MEDIA
} from '../indications.js';
import {
  defaultPrompt,
  LANGUAGES_WITH_FAILED_CALL_PROMPT
} from '../prompts.js';
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
import { playAndWait, playToneAndWait } from './playback.js';
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
  if (failure.kind !== 'final') {
    return;
  }
  await release(pipeline, call, failure.code, statusForFinalCode(failure.code));
}

/** Answers and plays the failed-call announcement, or — where the tenant's `language` (§11.4) has
 * no such prompt — ITU-T E.180's special information tone, to completion (§9.4 "Cross-trunk
 * failover"), the same answer-then-play order `announce.ts` uses, since this ARI layer has no
 * early media. A call with no caller channel (a party `api` adds) has nobody to play to. */
async function playFailedCallAnnouncement(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  const channelId = call.callerChannelId;
  if (channelId === null) {
    return;
  }
  await pipeline.deps.ari.channels.answer(channelId).catch(ignoreGone);
  const snapshot = await pipeline.deps.cache.get();
  if (LANGUAGES_WITH_FAILED_CALL_PROMPT.includes(snapshot.settings.language)) {
    await playAndWait(
      pipeline.deps.ari,
      channelId,
      defaultPrompt('failedCall'),
      `${channelId}:failed`
    );
    return;
  }
  await playToneAndWait(
    pipeline.deps.ari,
    channelId,
    SPECIAL_INFORMATION_TONE_MEDIA,
    `${channelId}:failed-tone`,
    SIT_DURATION_MS
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
