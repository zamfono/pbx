import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';

import { requiredOrigin } from '../../lib/auth/authorizationResponse.js';
import { getDb } from '../../lib/db.js';
import { handleMcpRequest } from '../../lib/mcp.js';
// Side-effect import: fills the registry (§10.3) every area's own operations register into, so
// `tools/list` offers the whole operation surface and every tool call finds its operation.
import '../../lib/ops/index.js';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required.');
  }
  return secret;
}

/** `POST /mcp`: the Streamable HTTP MCP endpoint (§10.5). */
export function POST(event: RequestEvent): Promise<Response> {
  return handleMcpRequest(
    { db: getDb(), jwtSecret: jwtSecret(), origin: requiredOrigin() },
    event.request
  );
}
