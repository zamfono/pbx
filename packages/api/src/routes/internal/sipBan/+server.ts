import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import {
  HTTP_BAD_REQUEST,
  HTTP_NO_CONTENT,
  sipBanReportSchema
} from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { publishEvent } from '#lib/server/eventSink.js';
import { readJsonBody } from '#lib/server/requestBody.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { recordSipBan } from '#lib/server/sipBanReport.js';
import { WebhookDispatcher } from '#lib/server/webhooks.js';

/**
 * `POST /internal/sipBan` (§3.1, §5.6 "Bans"): `core` reports an address whose failed SIP
 * attempts reached the threshold, over the `internal` network (`hooks.server.ts` refuses one that
 * came through the proxy hop). 204 whether a ban was written, the address already had one or
 * banning is off; 400 for a body the schema refuses.
 */
export async function POST(event: RequestEvent): Promise<Response> {
  const parsed = sipBanReportSchema.safeParse(
    await readJsonBody(event.request)
  );
  if (!parsed.success) {
    return new Response(null, { status: HTTP_BAD_REQUEST });
  }
  const db = getDb();
  const dispatcher = new WebhookDispatcher({ db, kr: keyringFromEnv(env) });
  await recordSipBan(
    db,
    {
      publish: publishEvent,
      enqueue: async envelope => dispatcher.enqueue(envelope)
    },
    parsed.data
  );
  return new Response(null, { status: HTTP_NO_CONTENT });
}
