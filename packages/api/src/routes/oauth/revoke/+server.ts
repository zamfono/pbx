import type { RequestEvent } from '@sveltejs/kit';

import { nowIso } from '@zamfono/shared';

import { revokeEndpoint } from '../../../lib/auth/oauth.js';
import { getDb } from '../../../lib/db.js';

/** `POST /oauth/revoke` (RFC 7009); §5.5 lists no rate limit for it. */
export function POST(event: RequestEvent): Promise<Response> {
  return revokeEndpoint({ db: getDb(), now: nowIso }, event.request);
}
