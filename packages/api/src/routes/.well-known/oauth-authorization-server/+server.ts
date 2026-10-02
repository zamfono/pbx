import * as env from '$app/env/private';

import { metadataDocument } from '#lib/server/auth/oauth.js';

/** RFC 8414 authorization server metadata (§5.2). */
export function GET(): Response {
  return Response.json(metadataDocument(env.ORIGIN ?? ''));
}
