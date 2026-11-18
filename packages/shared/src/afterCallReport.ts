/**
 * A call's forward-target attempts between `core` and `api` (§10.6 "After-call requests"): the
 * internal API's request body.
 */
import { z } from 'zod';

/** How an attempt of a forward target ended (§10.6 "After-call requests"): it answered, did not
 * work, or, for a ring-group member's followed forward, was given up when the group's ring
 * ended without it. */
export const ATTEMPT_OUTCOMES = ['answered', 'failed', 'cancelled'] as const;

/** One attempt of an `external`, `sip` or `webSocket` forward target with an after-call request:
 * what was dialled, how it ended and why, as the trace's `fallback` line names the cause, and
 * the values the call's templates had at the attempt. */
export const targetAttemptSchema = z.object({
  forwardTargetId: z.string(),
  kind: z.enum(['external', 'sip', 'webSocket']),
  external: z.string().optional(),
  trunkId: z.string().optional(),
  user: z.string().optional(),
  outcome: z.enum(ATTEMPT_OUTCOMES),
  cause: z.union([z.string(), z.number()]).nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  values: z.record(z.string(), z.unknown())
});
export type TargetAttempt = z.infer<typeof targetAttemptSchema>;

/** `POST /internal/afterCall` → 202: the attempts of one call, posted by `core` once the call's
 * history row and every recording of it are written (§10.6 "After-call requests"). */
export const afterCallReportSchema = z.object({
  callId: z.string(),
  attempts: z.array(targetAttemptSchema).min(1)
});
export type AfterCallReport = z.infer<typeof afterCallReportSchema>;
