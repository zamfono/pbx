import {
  createMcpHandler,
  originValidationResponse,
  type AuthInfo
} from '@modelcontextprotocol/server';

import {
  authenticate,
  unauthorizedResponse,
  type McpDeps
} from './mcp/auth.js';
import { mcpServer, type McpCall } from './mcp/server.js';
import { MAX_BODY_BYTES } from './requestBody.js';

export type { McpDeps } from './mcp/auth.js';

// `legacy: 'reject'`: 2026-07-28 is the one revision served (§10.5), so a 2025-era `initialize` is
// refused as an unsupported version.
const handler = createMcpHandler(mcpServer, {
  legacy: 'reject',
  maxRequestBodySize: MAX_BODY_BYTES
});

// `POST /mcp` (§10.5): a mutating tool call runs through `runOperation` with `channel: 'mcp'`,
// so RBAC, confirmation and the audit trail behave exactly as they do for REST.
export async function handleMcpRequest(
  deps: McpDeps,
  request: Request
): Promise<Response> {
  // Before anything else, authentication included: the transport's DNS-rebinding check covers
  // every incoming connection, and the one host a browser page may send is the stack's own.
  const forbidden = originValidationResponse(request, [
    new URL(deps.origin).hostname
  ]);
  if (forbidden) {
    return forbidden;
  }
  const auth = await authenticate(deps, request);
  if (!auth) {
    return unauthorizedResponse(deps.origin);
  }
  const authInfo: AuthInfo = {
    token: '',
    clientId: auth.clientId ?? '',
    scopes: [],
    extra: { deps, auth } satisfies McpCall
  };
  return handler.fetch(request, { authInfo });
}
