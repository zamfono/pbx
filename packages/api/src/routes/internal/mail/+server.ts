import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import pino from 'pino';
import { z } from 'zod';

import { getDb } from '$lib/server/db.js';
import { tryReadJson } from '$lib/server/json.js';
import { sendMail } from '$lib/server/mail/index.js';
import { keyringFromEnv } from '$lib/server/secretbox.js';

const logger = pino({ name: 'internal-mail' });

const STATUS_NOT_FOUND = 404;
const STATUS_BAD_REQUEST = 400;
const STATUS_ACCEPTED = 202;

// §11.6: voicemail audio lives under this media-volume prefix; `attachmentPath` is constrained
// to it so a malformed request cannot make `sendMail` attach an arbitrary readable file.
const ATTACHMENT_PREFIX = '/media/voicemail/';

const toUserOrRingGroup = z.union([
  z.object({ userId: z.string() }),
  z.object({ ringGroupId: z.string() })
]);

/** `MailRequest` (§3, §3.1 "Mail"), validated at the internal-network boundary. */
const mailRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('voicemail'),
    callId: z.string().optional(),
    to: toUserOrRingGroup,
    values: z.object({
      callerNumber: z.string(),
      callerName: z.string(),
      mailboxName: z.string(),
      receivedAt: z.string(),
      durationS: z.number()
    }),
    attachmentPath: z
      .string()
      .startsWith(ATTACHMENT_PREFIX)
      .refine(
        attachmentPath => !attachmentPath.includes('..'),
        'must not contain ..'
      )
  }),
  z.object({
    kind: z.literal('missedCall'),
    callId: z.string().optional(),
    to: z.object({ userId: z.string() }),
    values: z.object({
      callerNumber: z.string(),
      callerName: z.string(),
      receivedAt: z.string(),
      didLabel: z.string()
    })
  })
]);

async function handleMailRequest(request: Request): Promise<Response> {
  const parsed = mailRequestSchema.safeParse(await tryReadJson(request));
  if (!parsed.success) {
    return new Response(null, { status: STATUS_BAD_REQUEST });
  }
  const req = parsed.data;
  const db = getDb();
  const kr = keyringFromEnv(process.env);
  // §10.2 "Failure": the retries run in process over some minutes; the caller does not wait
  // for them, only for the request to be accepted.
  sendMail(db, kr, req).catch((error: unknown) => {
    // §7: a mail about a call is a call-related line, so it carries the call's id.
    logger.warn(
      { err: error, kind: req.kind, callId: req.callId },
      'internal-mail: send threw'
    );
  });
  return new Response(null, { status: STATUS_ACCEPTED });
}

/**
 * `POST /internal/mail` (§3.1 "Mail", §10.2 "Mail"): `core` posts a voicemail or missed-call
 * mail request here. Reachable from the `internal` network only — Caddy answers 404 for the
 * `/internal` prefix, so a request that carries `X-Forwarded-For` came through the proxy hop
 * instead and is refused the same way.
 */
export function POST(event: RequestEvent): Promise<Response> {
  if (event.request.headers.has('x-forwarded-for')) {
    return Promise.resolve(new Response(null, { status: STATUS_NOT_FOUND }));
  }
  return handleMailRequest(event.request);
}
