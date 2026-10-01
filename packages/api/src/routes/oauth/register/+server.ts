import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

import { nowIso } from '@zamfono/shared';

import { registerEndpoint } from '$lib/server/auth/oauth.js';
import { getDb } from '$lib/server/db.js';
import { keyringFromEnv } from '$lib/server/secretbox.js';

/** `POST /oauth/register` (RFC 7591 dynamic client registration). */
export function POST(event: RequestEvent): Promise<Response> {
  return registerEndpoint(
    {
      db: getDb(),
      keyring: keyringFromEnv(env),
      now: nowIso
    },
    event.request
  );
}
