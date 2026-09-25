import process from 'node:process';

import { metadataDocument } from '../../../lib/auth/oauth.js';

/** RFC 8414 authorization server metadata (§5.2). */
export function GET(): Response {
  return Response.json(metadataDocument(process.env.ORIGIN ?? ''));
}
