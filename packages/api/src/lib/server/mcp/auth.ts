import { HTTP_UNAUTHORIZED, type Db } from '@zamfono/shared';

import { authenticateRequest, type Authenticated } from '../auth/bearer.js';
import { mcpResourceUri } from '../auth/resource.js';

// §10.5 "Auth": an MCP request acts as the user its OAuth 2.1 bearer token names, and a mutating
// tool call is audited under that user plus the MCP client's OAuth client id and name.

/** What the MCP endpoint needs beyond the request itself. */
export type McpDeps = { db: Db; jwtSecret: string; origin: string };

/** The request's user and client; MCP authorization "Token Handling": only a token issued for
 *  this MCP server is accepted. */
export function authenticate(
  deps: McpDeps,
  request: Request
): Promise<Authenticated | null> {
  return authenticateRequest(deps, request, mcpResourceUri(deps.origin));
}

/** The 401 an unauthenticated request gets, pointing the client at the resource metadata. */
export function unauthorizedResponse(origin: string): Response {
  return new Response(null, {
    status: HTTP_UNAUTHORIZED,
    headers: {
      'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    }
  });
}

/** RFC 9728 protected-resource metadata: the MCP endpoint points at the stack's own AS (§5.2). */
export function protectedResourceMetadata(origin: string): object {
  return { resource: mcpResourceUri(origin), authorization_servers: [origin] };
}
