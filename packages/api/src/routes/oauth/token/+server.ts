import type { RequestEvent } from '@sveltejs/kit';

import { nowIso } from '@zamfono/shared';

import { requiredOrigin } from '$lib/server/auth/authorizationResponse.js';
import { authCodeStore } from '$lib/server/auth/codes.js';
import { requiredJwtSecret } from '$lib/server/auth/jwt.js';
import { tokenEndpoint } from '$lib/server/auth/oauth.js';
import { getDb } from '$lib/server/db.js';

/** `POST /oauth/token`: the authorization-code (PKCE) and refresh-token grants (§5.2). */
export function POST(event: RequestEvent): Promise<Response> {
  return tokenEndpoint(
    {
      db: getDb(),
      jwtSecret: requiredJwtSecret(),
      codes: authCodeStore,
      origin: requiredOrigin(),
      now: nowIso
    },
    event.request
  );
}
