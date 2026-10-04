import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  isRecord,
  newId
} from '@zamfono/shared';

import {
  JSONRPC_INVALID_REQUEST,
  jsonRpcErrorWithStatus,
  type IncomingMessage
} from './jsonRpc.js';

// Legacy 2025-11-25 sessions are the one stateful corner of an otherwise stateless server (§10.5):
// a session starts at `initialize`, which returns this id via `Mcp-Session-Id` for the client to
// echo, with `MCP-Protocol-Version`, on every later request; the client's elicitation capability —
// declared once, in that handshake — is looked up by it. Current-era clients carry no session id
// and declare version and capabilities in each request's `_meta` instead.
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const CURRENT_PROTOCOL_VERSION = '2026-07-28';
/** Every revision the server speaks, as `server/discover` and `UnsupportedProtocolVersion` list them. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  CURRENT_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION
];
export const SESSION_ID_HEADER = 'mcp-session-id';
export const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';
/** The legacy revisions `initialize` can negotiate: the one §10.5 names. */
const LEGACY_PROTOCOL_VERSIONS: readonly string[] = [LEGACY_PROTOCOL_VERSION];

type LegacySession = { elicits: boolean; protocolVersion: string };
/** Each user's legacy sessions by id, oldest first (a Map keeps insertion order). A session is
 *  its user's alone: another user's request with its id finds nothing. */
const legacySessions = new Map<string, Map<string, LegacySession>>();
// ponytail: no client ever closes a legacy session explicitly, so each user's sessions are capped
// by dropping that user's oldest (insertion order) rather than tracked per-session expiry; a
// persistent session store replaces this if the api ever runs more than one instance behind a
// load balancer.
const MAX_LEGACY_SESSIONS_PER_USER = 10;

/** How a request's confirmation is asked (§10.5): which era's shapes, and whether it can elicit. */
export type Era = { legacy: boolean; elicits: boolean };

// Whether the client can answer the form-mode elicitation a confirmation asks. MCP clients declare
// it as an object: `{ elicitation: {} }` means form mode only, `{ elicitation: { form: {} } }`
// names it, and `{ elicitation: { url: {} } }` alone offers URL mode, which cannot carry the
// question's boolean field. A bare `true` is also read as support.
export function hasElicitationCapability(
  capabilities: Record<string, unknown> | null | undefined
): boolean {
  if (!capabilities || !('elicitation' in capabilities)) {
    return false;
  }
  const value = capabilities.elicitation;
  if (value === true) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return 'form' in value || !('url' in value);
}

/**
 * The version `initialize` answers with, per the 2025-11-25 lifecycle's "Version Negotiation":
 * the requested one if the server supports it, otherwise the latest it does
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation).
 * Only a legacy revision can be negotiated here: 2026-07-28 has no `initialize`, so a request
 * for it, like one for any version this server lacks, gets the latest legacy revision, and the
 * client disconnects if it cannot speak that.
 */
export function negotiateLegacyVersion(requested: string): string {
  return LEGACY_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LEGACY_PROTOCOL_VERSION;
}

/** Starts `userId`'s legacy session for `initialize`'s `params.capabilities` and negotiated
 * version, returning its `Mcp-Session-Id`. */
export function startLegacySession(
  userId: string,
  capabilities: unknown,
  protocolVersion: string
): string {
  const sessionId = newId();
  const sessions =
    legacySessions.get(userId) ?? new Map<string, LegacySession>();
  if (sessions.size >= MAX_LEGACY_SESSIONS_PER_USER) {
    const oldest = sessions.keys().next();
    if (oldest.done !== true) {
      sessions.delete(oldest.value);
    }
  }
  sessions.set(sessionId, {
    elicits: hasElicitationCapability(
      isRecord(capabilities) ? capabilities : null
    ),
    protocolVersion
  });
  legacySessions.set(userId, sessions);
  return sessionId;
}

/**
 * Whether a request belongs to a legacy session. A dual-era server selects its behaviour from how
 * the client opens: a request carrying the per-request `_meta` version is served statelessly as
 * 2026-07-28 whatever else it carries, and `initialize` (answered before this is asked) starts a
 * legacy session, whose later requests carry its `Mcp-Session-Id` and the legacy
 * `MCP-Protocol-Version` instead
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions).
 * Anything else is a 2026-07-28 request, checked as one (`./modernRequest.js`).
 */
function isLegacyRequest(request: Request, msg: IncomingMessage): boolean {
  if (msg.meta.declaresVersion) {
    return false;
  }
  return (
    request.headers.has(SESSION_ID_HEADER) ||
    LEGACY_PROTOCOL_VERSIONS.includes(
      request.headers.get(PROTOCOL_VERSION_HEADER) ?? ''
    )
  );
}

/**
 * A legacy request's session, per the 2025-11-25 Streamable HTTP transport
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management):
 * without `Mcp-Session-Id` it is refused with 400, as a server that requires one SHOULD; a
 * session this process does not hold for the requesting user (evicted, lost to a restart, or
 * another user's) with 404, which it MUST, telling the client to `initialize` again; and an
 * `MCP-Protocol-Version` other than the one the session negotiated with 400, which it MUST for an
 * unsupported one. With no version header the negotiated version stands, the "other way to
 * identify the version" that revision allows.
 */
function legacySession(
  request: Request,
  msg: IncomingMessage,
  userId: string
): LegacySession | Response {
  const reject = (status: number, message: string): Response =>
    jsonRpcErrorWithStatus(status, msg.id, JSONRPC_INVALID_REQUEST, message);
  const sessionId = request.headers.get(SESSION_ID_HEADER);
  if (sessionId === null) {
    return reject(HTTP_BAD_REQUEST, 'missing Mcp-Session-Id header');
  }
  const session = legacySessions.get(userId)?.get(sessionId);
  if (!session) {
    return reject(HTTP_NOT_FOUND, 'session not found; initialize again');
  }
  const version = request.headers.get(PROTOCOL_VERSION_HEADER);
  if (version !== null && version !== session.protocolVersion) {
    return reject(
      HTTP_BAD_REQUEST,
      `unsupported MCP-Protocol-Version '${version}'`
    );
  }
  return session;
}

/** The confirmation era for one request, or the response refusing a legacy request whose session
 * does not stand: a legacy session's capabilities were declared at its `initialize`; a 2026-07-28
 * request declares them in its own `_meta`. */
export function resolveEra(
  request: Request,
  msg: IncomingMessage,
  userId: string
): Era | Response {
  if (isLegacyRequest(request, msg)) {
    const session = legacySession(request, msg, userId);
    return session instanceof Response
      ? session
      : { legacy: true, elicits: session.elicits };
  }
  return {
    legacy: false,
    elicits: hasElicitationCapability(msg.meta.capabilities)
  };
}
