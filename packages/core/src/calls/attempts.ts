/**
 * The attempts of forward targets that have an after-call request (§10.6 "After-call
 * requests"): each attempt of an `external`, `sip` or `webSocket` target is noted on its call as
 * it ends, with how it ended, and the call's attempts are posted to `api` once its history row
 * and every recording of it are written; `api` builds and delivers the requests.
 */
import type { TargetAttempt } from '@zamfono/shared';

import { logFailure } from '../ari/failures.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { Call } from './call.js';
import { dialCause, type DialResult } from './dialAttempt.js';
import { templateValues } from './forwardValues.js';
import type { Pipeline } from './pipeline.js';

/** How an attempt ended: answered, or why not, as the trace's `fallback` line names the cause
 * (§10.1 step 7): the far end's final status, else what kept the target from answering. */
export type AttemptEnd = Pick<TargetAttempt, 'outcome' | 'cause'>;

/** A waiting dial's `result` as an attempt's end. */
export function dialEnd(result: DialResult): AttemptEnd {
  if (result.kind === 'answered') {
    return { outcome: 'answered', cause: null };
  }
  return {
    outcome: 'failed',
    cause:
      result.kind === 'final' && result.failure.kind === 'final'
        ? result.failure.code
        : (dialCause(result) ?? 'noRoute')
  };
}

/** What `target` dials, as an attempt names it: its number, or its trunk and user part; a bot's
 * URL is left out, since it carries the bot's token. */
function dialled(
  target: ForwardTarget
): Pick<TargetAttempt, 'external' | 'trunkId' | 'user'> {
  if (target.kind === 'external') {
    return { external: target.number };
  }
  return target.kind === 'sip'
    ? { trunkId: target.trunkId, user: target.user }
    : {};
}

/**
 * Notes an attempt of `target` on `call`, begun at `startedAt` and ended as `end` says; nothing
 * for a target without an after-call request. The attempt keeps the values the call's templates
 * have now, its variables among them, for the request's own. Returns the attempt, whose end a
 * leg still ringing may yet change (`ringGroupExternal.ts`).
 */
export async function noteAttempt(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget | undefined,
  startedAt: string,
  end: AttemptEnd
): Promise<TargetAttempt | null> {
  if (
    target === undefined ||
    !('afterCallOf' in target) ||
    target.afterCallOf === undefined
  ) {
    return null;
  }
  const snapshot = await pipeline.deps.cache.get();
  const attempt: TargetAttempt = {
    forwardTargetId: target.afterCallOf,
    kind: target.kind,
    ...dialled(target),
    ...end,
    startedAt,
    endedAt: pipeline.deps.now(),
    values: await templateValues(pipeline, call, snapshot)
  };
  call.attempts.push(attempt);
  return attempt;
}

/**
 * Posts `call`'s attempts to `api`, once every recording of the call is written; the history row
 * is, since this runs after it. One request, no retry: `api`'s outbox takes it from there, and a
 * report it never got is logged and lost, as an event to a stopped `api` is.
 */
export async function reportAttempts(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  if (call.attempts.length === 0) {
    return;
  }
  const { recorder, reports, logger } = pipeline.deps;
  await recorder.settled(call.id);
  await reports
    .afterCall({ callId: call.id, attempts: call.attempts })
    .catch(logFailure(logger, 'after-call report', { callId: call.id }));
}
