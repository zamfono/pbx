import { metadataDocument } from '#lib/server/auth/oauth.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

/** RFC 8414 authorization server metadata (§5.2). */
export function GET(): Response {
  return Response.json(metadataDocument(originFromEnv()));
}
