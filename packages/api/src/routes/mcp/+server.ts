import type { RequestEvent } from '@sveltejs/kit';

import { requiredOrigin } from '../../lib/auth/authorizationResponse.js';
import { requiredJwtSecret } from '../../lib/auth/jwt.js';
import { getDb } from '../../lib/db.js';
import { handleMcpRequest } from '../../lib/mcp.js';
// Side-effect import: fills the registry (§10.3) every area's own operations register into, so
// `tools/list` offers the whole operation surface and every tool call finds its operation.
import '../../lib/ops/index.js';

/** `POST /mcp`: the Streamable HTTP MCP endpoint (§10.5). */
export function POST(event: RequestEvent): Promise<Response> {
  return handleMcpRequest(
    { db: getDb(), jwtSecret: requiredJwtSecret(), origin: requiredOrigin() },
    event.request
  );
}
