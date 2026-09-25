import type { Db } from '@zamfono/shared';

import { isRole, verifyAccessToken } from '../auth/jwt.js';
import { mcpResourceUri } from '../auth/resource.js';
import type { Actor } from '../ops/types.js';

// §10.5 "Auth": an MCP request acts as the user its OAuth 2.1 bearer token names, and a mutating
// tool call is audited under that user plus the MCP client's OAuth client id and name.
const STATUS_UNAUTHORIZED = 401;
const MS_PER_SECOND = 1000;
const BEARER_PREFIX = 'Bearer ';

/** What the MCP endpoint needs beyond the request itself. */
export type McpDeps = { db: Db; jwtSecret: string; origin: string };

export type Authenticated = {
  actor: Actor;
  clientId?: string;
  clientName?: string;
};

export async function authenticate(
  deps: McpDeps,
  request: Request
): Promise<Authenticated | null> {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const nowS = Math.floor(Date.now() / MS_PER_SECOND);
  const token = header.slice(BEARER_PREFIX.length);
  // MCP authorization "Token Handling": only a token issued for this MCP server is accepted.
  const claims = verifyAccessToken(
    deps.jwtSecret,
    token,
    nowS,
    mcpResourceUri(deps.origin)
  );
  if (!claims) {
    return null;
  }
  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'name', 'role'])
    .where('id', '=', claims.sub)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!user || !isRole(user.role)) {
    return null;
  }
  const client = claims.cid
    ? await deps.db
        .selectFrom('oauthClients')
        .select('name')
        .where('clientId', '=', claims.cid)
        .executeTakeFirst()
    : undefined;
  return {
    actor: { id: user.id, name: user.name, role: user.role },
    clientId: claims.cid ?? undefined,
    clientName: client?.name
  };
}

/** The 401 an unauthenticated request gets, pointing the client at the resource metadata. */
export function unauthorizedResponse(origin: string): Response {
  return new Response(null, {
    status: STATUS_UNAUTHORIZED,
    headers: {
      'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    }
  });
}

/** RFC 9728 protected-resource metadata: the MCP endpoint points at the stack's own AS (§5.2). */
export function protectedResourceMetadata(origin: string): object {
  /* eslint-disable camelcase -- RFC 9728 mandates this snake_case wire field */
  return { resource: mcpResourceUri(origin), authorization_servers: [origin] };
  /* eslint-enable camelcase -- RFC 9728 mandates this snake_case wire field */
}
