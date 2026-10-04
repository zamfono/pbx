import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import pino from 'pino';

import {
  HTTP_ACCEPTED,
  HTTP_BAD_REQUEST,
  mailRequestSchema
} from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { tryReadJson } from '#lib/server/json.js';
import { sendMail } from '#lib/server/mail/index.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

const logger = pino({ name: 'internal-mail' });

async function handleMailRequest(request: Request): Promise<Response> {
  const parsed = mailRequestSchema.safeParse(await tryReadJson(request));
  if (!parsed.success) {
    return new Response(null, { status: HTTP_BAD_REQUEST });
  }
  const req = parsed.data;
  const db = getDb();
  const kr = keyringFromEnv(env);
  // §10.2 "Failure": the retries run in process over some minutes; the caller does not wait
  // for them, only for the request to be accepted.
  sendMail(db, kr, req).catch((error: unknown) => {
    // §7: a mail about a call is a call-related line, so it carries the call's id.
    logger.warn(
      { err: error, kind: req.kind, callId: req.callId },
      'internal-mail: send threw'
    );
  });
  return new Response(null, { status: HTTP_ACCEPTED });
}

/**
 * `POST /internal/mail` (§3.1 "Mail", §10.2 "Mail"): `core` posts a voicemail or missed-call
 * mail request here, over the `internal` network (`hooks.server.ts` refuses one that came
 * through the proxy hop).
 */
export async function POST(event: RequestEvent): Promise<Response> {
  return handleMailRequest(event.request);
}
