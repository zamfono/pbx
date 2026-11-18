import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import pino from 'pino';

import {
  afterCallReportSchema,
  HTTP_ACCEPTED,
  HTTP_BAD_REQUEST
} from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { readJsonBody } from '#lib/server/requestBody.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { originFromEnv } from '#lib/server/stackAddress.js';
import { WebhookDispatcher } from '#lib/server/webhooks.js';

const logger = pino({ name: 'internal-after-call' });

/**
 * `POST /internal/afterCall` (§3.1, §10.6 "After-call requests"): `core` posts the attempts of
 * a call's forward targets here once the call's history row and every recording of it are
 * written, over the `internal` network (`hooks.server.ts` refuses a request that came through
 * the proxy hop or carries no `INTERNAL_TOKEN`). Each attempt whose target has an after-call
 * request is queued in the outbox; the deliveries run on without the caller waiting. 202, or 400
 * for a body the schema refuses.
 */
export async function POST(event: RequestEvent): Promise<Response> {
  const parsed = afterCallReportSchema.safeParse(
    await readJsonBody(event.request)
  );
  if (!parsed.success) {
    return new Response(null, { status: HTTP_BAD_REQUEST });
  }
  const dispatcher = new WebhookDispatcher({
    db: getDb(),
    kr: keyringFromEnv(env),
    targetPolicy: { allowPrivate: env.ALLOW_PRIVATE_TARGETS },
    links: () => ({ jwtSecret: env.JWT_SECRET, origin: originFromEnv() })
  });
  dispatcher.enqueueAfterCall(parsed.data).catch((error: unknown) => {
    logger.warn(
      { err: error, callId: parsed.data.callId },
      'after-call request delivery failed'
    );
  });
  return new Response(null, { status: HTTP_ACCEPTED });
}
