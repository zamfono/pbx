import { requiredOrigin } from '#lib/auth/authorizationResponse.js';
import { protectedResourceMetadata } from '#lib/mcp/auth.js';

/** RFC 9728 protected-resource metadata for the MCP endpoint (§10.5, §5.2). */
export function GET(): Response {
  return Response.json(protectedResourceMetadata(requiredOrigin()));
}
