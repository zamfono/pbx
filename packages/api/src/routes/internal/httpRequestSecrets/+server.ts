import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  httpRequestSecretsRequestSchema,
  type HttpRequestSecrets
} from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { attempt } from '#lib/server/errors.js';
import { readBlock } from '#lib/server/ops/httpRequestBlock.js';
import { HTTP_REQUEST_PURPOSES } from '#lib/server/ops/httpRequests/_shared.js';
import { readJsonBody } from '#lib/server/requestBody.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

/**
 * `POST /internal/httpRequestSecrets` (§3.1, §5.4): `core` sends a call flow's HTTP request
 * itself, while the call waits, but holds no key, so it asks here for the request's signing
 * secret and its headers with their values, over the `internal` network (`hooks.server.ts`
 * refuses a request that came through the proxy hop or carries no `INTERNAL_TOKEN`). 404 for a
 * request that is not live or whose secrets cannot be decrypted, 400 for a body the schema
 * refuses.
 */
export async function POST(event: RequestEvent): Promise<Response> {
  const parsed = httpRequestSecretsRequestSchema.safeParse(
    await readJsonBody(event.request)
  );
  if (!parsed.success) {
    return new Response(null, { status: HTTP_BAD_REQUEST });
  }
  const row = await getDb()
    .selectFrom('httpRequests')
    .selectAll()
    .where('id', '=', parsed.data.id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  const stored =
    row &&
    attempt(() => readBlock(keyringFromEnv(env), HTTP_REQUEST_PURPOSES, row));
  if (stored === undefined) {
    return new Response(null, { status: HTTP_NOT_FOUND });
  }
  const secrets: HttpRequestSecrets = {
    secret: stored.secret,
    headers: stored.headers
  };
  return Response.json(secrets, { headers: { 'cache-control': 'no-store' } });
}
