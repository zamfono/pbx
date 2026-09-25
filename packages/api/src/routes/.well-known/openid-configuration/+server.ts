import process from 'node:process';

import { metadataDocument } from '../../../lib/auth/oauth.js';

// Some MCP and OIDC clients probe this path even though `api` issues no ID tokens; it serves
// the same RFC 8414 document as `/.well-known/oauth-authorization-server` (§5.2).
export function GET(): Response {
  return Response.json(metadataDocument(process.env.ORIGIN ?? ''));
}
