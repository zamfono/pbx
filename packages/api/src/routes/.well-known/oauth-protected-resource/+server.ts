import { protectedResourceMetadata } from '#lib/server/mcp/auth.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

/** RFC 9728 protected-resource metadata for the MCP endpoint (§10.5, §5.2). */
export function GET(): Response {
  return Response.json(protectedResourceMetadata(originFromEnv()));
}
