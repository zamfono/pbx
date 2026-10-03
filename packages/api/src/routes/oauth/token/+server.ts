import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import { nowIso } from '@zamfono/shared';

import { originFromEnv } from '#lib/server/auth/authorizationResponse.js';
import { authCodeStore } from '#lib/server/auth/codes.js';
import { tokenEndpoint } from '#lib/server/auth/tokenEndpoint.js';
import { getDb } from '#lib/server/db.js';

/** `POST /oauth/token`: the authorization-code (PKCE) and refresh-token grants (§5.2). */
export function POST(event: RequestEvent): Promise<Response> {
  return tokenEndpoint(
    {
      db: getDb(),
      jwtSecret: env.JWT_SECRET,
      codes: authCodeStore,
      origin: originFromEnv(),
      now: nowIso
    },
    event.request
  );
}
