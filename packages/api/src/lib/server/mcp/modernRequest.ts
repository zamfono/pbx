import { HTTP_BAD_REQUEST } from '@zamfono/shared';

import {
  CURRENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  SUPPORTED_PROTOCOL_VERSIONS
} from './era.js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  JSONRPC_INVALID_PARAMS,
  jsonRpcErrorWithStatus,
  PROTOCOL_VERSION_META_KEY,
  type IncomingMessage
} from './jsonRpc.js';

// What a 2026-07-28 server checks on a request before running it. Every rejection is
// `400 Bad Request` with a JSON-RPC error body, which is how a dual-era client tells a modern
// server's refusal from a legacy server's (streamable-http#backward-compatibility):
// - the per-request `_meta` fields the revision marks required, `-32602`
//   (https://modelcontextprotocol.io/specification/2026-07-28/basic#meta);
// - the standard headers, `MCP-Protocol-Version`, `Mcp-Method` and, for the three methods that
//   name a target, `Mcp-Name`: missing, malformed, or not matching the body is `HeaderMismatch`
//   (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation);
// - a version the server does not speak, `UnsupportedProtocolVersion` listing the ones it does
//   (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).
// No tool here designates `x-mcp-header` parameters, so no `Mcp-Param-*` header is recognised.
export const HEADER_MISMATCH = -32020;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_HEADER = 'mcp-method';
const NAME_HEADER = 'mcp-name';
// Header values are visible ASCII, space and tab (RFC 9110 §5.5); anything else travels in the
// Base64 sentinel `=?base64?…?=`, which the server decodes before comparing.
const PLAIN_HEADER_VALUE = /^[\t\x20-\x7e]*$/u;
const BASE64_SENTINEL = /^=\?base64\?(?<encoded>[A-Za-z0-9+/]*={0,2})\?=$/u;
const SENTINEL_PREFIX = '=?base64?';
/** The body field each targeted method mirrors into `Mcp-Name`. */
const NAME_SOURCE = new Map<string, 'name' | 'uri'>([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri']
]);

function badRequest(
  msg: IncomingMessage,
  code: number,
  message: string,
  data?: unknown
): Response {
  return jsonRpcErrorWithStatus(HTTP_BAD_REQUEST, msg.id, code, message, data);
}

function headerMismatch(msg: IncomingMessage, message: string): Response {
  return badRequest(msg, HEADER_MISMATCH, `Header mismatch: ${message}`);
}

/** An `Mcp-Name` value as the client meant it, or `null` when it is malformed. */
function decodeHeaderValue(value: string): string | null {
  const sentinel = BASE64_SENTINEL.exec(value);
  // The regex's `encoded` group is mandatory, so a match always sets it.
  if (sentinel?.groups?.encoded !== undefined) {
    return Buffer.from(sentinel.groups.encoded, 'base64').toString('utf8');
  }
  // A plain value that looks like a sentinel but does not decode is malformed, not literal:
  // clients must encode such a value themselves.
  if (value.startsWith(SENTINEL_PREFIX) || !PLAIN_HEADER_VALUE.test(value)) {
    return null;
  }
  return value;
}

/** The `Mcp-Name` check for the methods that name their target, or `null` when it passes. A body
 * without the field has no value to mirror; the method itself then refuses it as `-32602`. */
function nameHeaderRejection(
  request: Request,
  msg: IncomingMessage
): Response | null {
  const source = NAME_SOURCE.get(msg.method);
  if (source === undefined) {
    return null;
  }
  const header = request.headers.get(NAME_HEADER);
  const bodyValue = msg.params[source];
  if (typeof bodyValue !== 'string') {
    return header === null
      ? null
      : headerMismatch(msg, `Mcp-Name header has no body value to match`);
  }
  if (header === null) {
    return headerMismatch(msg, 'missing Mcp-Name header');
  }
  const decoded = decodeHeaderValue(header);
  if (decoded === null) {
    return headerMismatch(msg, 'malformed Mcp-Name header');
  }
  return decoded === bodyValue
    ? null
    : headerMismatch(
        msg,
        `Mcp-Name header value '${decoded}' does not match body value '${bodyValue}'`
      );
}

/** Why a 2026-07-28 request is rejected before it runs, as its 400 response; `null` to serve it. */
export function modernRequestRejection(
  request: Request,
  msg: IncomingMessage
): Response | null {
  const versionHeader = request.headers.get(PROTOCOL_VERSION_HEADER);
  if (versionHeader === null) {
    return headerMismatch(msg, 'missing MCP-Protocol-Version header');
  }
  const { protocolVersion, capabilities } = msg.meta;
  if (protocolVersion === undefined || capabilities === undefined) {
    const key =
      protocolVersion === undefined
        ? PROTOCOL_VERSION_META_KEY
        : CLIENT_CAPABILITIES_META_KEY;
    return badRequest(
      msg,
      JSONRPC_INVALID_PARAMS,
      `missing required _meta field '${key}'`
    );
  }
  if (versionHeader !== protocolVersion) {
    return headerMismatch(
      msg,
      `MCP-Protocol-Version header value '${versionHeader}' does not match body value '${protocolVersion}'`
    );
  }
  // Only this revision travels in per-request `_meta`; the legacy one is offered through
  // `initialize`, and both are listed so the client can pick either (versioning page).
  if (protocolVersion !== CURRENT_PROTOCOL_VERSION) {
    return badRequest(
      msg,
      UNSUPPORTED_PROTOCOL_VERSION,
      'Unsupported protocol version',
      { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: protocolVersion }
    );
  }
  const methodHeader = request.headers.get(METHOD_HEADER);
  if (methodHeader === null) {
    return headerMismatch(msg, 'missing Mcp-Method header');
  }
  if (methodHeader !== msg.method) {
    return headerMismatch(
      msg,
      `Mcp-Method header value '${methodHeader}' does not match body value '${msg.method}'`
    );
  }
  return nameHeaderRejection(request, msg);
}
