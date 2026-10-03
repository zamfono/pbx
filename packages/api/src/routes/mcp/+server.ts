import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import { originFromEnv } from '#lib/server/auth/authorizationResponse.js';
import { getDb } from '#lib/server/db.js';
import { handleMcpRequest } from '#lib/server/mcp.js';

/** `POST /mcp`: the Streamable HTTP MCP endpoint (§10.5). */
export function POST(event: RequestEvent): Promise<Response> {
  return handleMcpRequest(
    { db: getDb(), jwtSecret: env.JWT_SECRET, origin: originFromEnv() },
    event.request
  );
}
