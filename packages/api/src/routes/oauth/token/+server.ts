import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';

import { nowIso } from '@zamfono/shared';

import { requiredOrigin } from '../../../lib/auth/authorizationResponse.js';
import { authCodeStore } from '../../../lib/auth/codes.js';
import { tokenEndpoint } from '../../../lib/auth/oauth.js';
import { getDb } from '../../../lib/db.js';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required.');
  }
  return secret;
}

/** `POST /oauth/token`: the authorization-code (PKCE) and refresh-token grants (§5.2). */
export function POST(event: RequestEvent): Promise<Response> {
  return tokenEndpoint(
    {
      db: getDb(),
      jwtSecret: jwtSecret(),
      codes: authCodeStore,
      origin: requiredOrigin(),
      now: nowIso
    },
    event.request
  );
}
