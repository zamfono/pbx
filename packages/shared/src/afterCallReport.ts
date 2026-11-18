/**
 * What `core` and `api` exchange for the HTTP requests of a call (§10.6): a call's
 * forward-target attempts, for its after-call requests, and the secrets of a call flow's HTTP
 * request, which `core` sends itself.
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

/** `POST /internal/httpRequestSecrets` → 200 `HttpRequestSecrets` | 404 (§5.4): what `core`,
 * which holds no key, needs of a call flow's HTTP request to send it: its signing secret and
 * its headers with their values, the secret ones decrypted. */
export const httpRequestSecretsRequestSchema = z.object({ id: z.string() });
export const httpRequestSecretsSchema = z.object({
  secret: z.string().nullable(),
  headers: z.array(z.object({ name: z.string(), value: z.string() }))
});
export type HttpRequestSecrets = z.infer<typeof httpRequestSecretsSchema>;
