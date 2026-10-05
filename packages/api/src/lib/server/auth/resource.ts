/**
 * RFC 8707 resource indicators (§10.5 "Auth" follows the MCP 2026-07-28 authorization spec, whose
 * "Resource Parameter Implementation" has every MCP client send `resource` on the authorization
 * and token requests, and whose "Token Handling" has the MCP server "validate that access tokens
 * were issued specifically for them as the intended audience").
 *
 * The one protected resource this stack publishes metadata for (RFC 9728) is its MCP endpoint, so
 * it is the one resource the authorization server issues tokens for: every access token carries
 * it as `aud`. A request without `resource` gets the same audience, RFC 8707 §2's "predefined
 * default resource value", since §5.2 makes this server "the only way to obtain a token, for REST
 * and MCP alike" and its REST clients send none. The REST API (§10.3 "JWT bearer auth (tokens
 * issued by the OAuth server, §5)") accepts any token this server issued and checks no audience.
 */

const MCP_PATH = '/mcp';
const FRAGMENT_MARK = '#';

/**
 * The canonical URI of this stack's MCP server (MCP authorization, "Canonical Server URI"):
 * `origin`'s own serialised origin, lowercase and without a trailing slash, plus `/mcp`.
 */
export function mcpResourceUri(origin: string): string {
  return `${new URL(origin).origin}${MCP_PATH}`;
}

/**
 * Whether `value` names this stack's MCP server. An RFC 8707 §2 resource "MUST be an absolute URI"
 * and "MUST NOT include a fragment component"; the scheme and host compare case-insensitively,
 * which the MCP spec's "SHOULD accept uppercase scheme and host components" asks of a server.
 */
function isMcpResource(origin: string, value: string): boolean {
  if (value.includes(FRAGMENT_MARK) || !URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return `${url.origin}${url.pathname}${url.search}` === mcpResourceUri(origin);
}

/**
 * Whether every `resource` parameter of an authorization or token request names this stack's MCP
 * server; one naming anything else is refused (by the token endpoint with RFC 8707 §2's
 * `invalid_target`, by `/oauth/authorize` with its error page), and a request
 * that sends none is accepted for the default resource.
 */
export function requestedResourceAcceptable(
  origin: string,
  params: URLSearchParams
): boolean {
  return params.getAll('resource').every(value => isMcpResource(origin, value));
}
