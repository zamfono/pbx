import { HTTP_FORBIDDEN } from '@zamfono/shared';

import { JSONRPC_INVALID_REQUEST } from './jsonRpc.js';

// DNS-rebinding protection, which both revisions' Streamable HTTP transport requires of every
// incoming connection: "Servers MUST validate the `Origin` header on all incoming connections to
// prevent DNS rebinding attacks. If the `Origin` header is present and invalid, servers MUST
// respond with HTTP 403 Forbidden. The HTTP response body MAY comprise a JSON-RPC error response
// that has no `id`."
// (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-%26-endpoint,
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning).
// The one valid origin is the stack's own, `https://${FQDN}` (§6.3), which a browser
// page served from this stack sends; a request without the header, as non-browser MCP clients
// send it, is not refused, since the rule only covers a header that is present.

/** The 403 refusing a request whose `Origin` is present and is not `origin`, or `null`. */
export function originRejection(
  request: Request,
  origin: string
): Response | null {
  const sent = request.headers.get('origin');
  // `Origin` is serialised canonically (RFC 6454 §6.1), so it is compared with the stack's
  // origin in the same form, its host name lowercased as an operator may not have written it.
  if (sent === null || sent === new URL(origin).origin) {
    return null;
  }
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: JSONRPC_INVALID_REQUEST, message: 'Origin not allowed' }
    },
    { status: HTTP_FORBIDDEN }
  );
}
