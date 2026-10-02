import type { RequestEvent } from '@sveltejs/kit';

import { requiredOrigin } from '#lib/server/auth/authorizationResponse.js';
import { requiredJwtSecret } from '#lib/server/auth/jwtSigning.js';
import { getDb } from '#lib/server/db.js';
import { handleMcpRequest } from '#lib/server/mcp.js';

/** `POST /mcp`: the Streamable HTTP MCP endpoint (§10.5). */
export function POST(event: RequestEvent): Promise<Response> {
  return handleMcpRequest(
    { db: getDb(), jwtSecret: requiredJwtSecret(), origin: requiredOrigin() },
    event.request
  );
}
