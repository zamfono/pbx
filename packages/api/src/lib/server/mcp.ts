import pino from 'pino';

import { HTTP_ACCEPTED, HTTP_NOT_FOUND, HTTP_OK } from '@zamfono/shared';

import type { Authenticated } from './auth/bearer.js';
import {
  authenticate,
  unauthorizedResponse,
  type McpDeps
} from './mcp/auth.js';
import {
  negotiateLegacyVersion,
  resolveEra,
  SESSION_ID_HEADER,
  startLegacySession,
  type Era
} from './mcp/era.js';
import INSTRUCTIONS_RAW from './mcp/instructions.txt?raw';
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  jsonRpcError,
  jsonRpcErrorWithStatus,
  jsonRpcResult,
  parseMessage,
  type IncomingMessage
} from './mcp/jsonRpc.js';
import { resolveElicitationAnswer } from './mcp/legacyElicitation.js';
import { modernRequestRejection } from './mcp/modernRequest.js';
import { originRejection } from './mcp/origin.js';
import { getPrompt, listPrompts, PromptRequestError } from './mcp/prompts.js';
import {
  discoverResult,
  initializeResult,
  listResult,
  promptResult
} from './mcp/results.js';
import { handleToolsCall } from './mcp/toolCall.js';
import { listTools } from './mcp/tools.js';
import { readJsonBody } from './requestBody.js';

export type { McpDeps } from './mcp/auth.js';

// Hand-rolled JSON-RPC/Streamable HTTP surface: @modelcontextprotocol/sdk does not support
// protocol revision 2026-07-28 (or the dual-era 2025-11-25 handshake) at implementation time.
// `?raw` bundles the text into the server chunk, so it ships regardless of the deployed tree's
// layout.
const INSTRUCTIONS = INSTRUCTIONS_RAW.trim();
const logger = pino({ name: 'mcp' });

// Legacy `initialize`: negotiates the session's version (`./mcp/era.js`) and starts the one
// stateful session this endpoint keeps, returned as `Mcp-Session-Id` for the client to echo, with
// `MCP-Protocol-Version`, on every later request. `protocolVersion` is a required string of
// 2025-11-25's `InitializeRequestParams`, so a request without one is `-32602`.
function legacyInitialize(msg: IncomingMessage, userId: string): Response {
  const requested = msg.params.protocolVersion;
  if (typeof requested !== 'string') {
    return jsonRpcError(
      msg.id,
      JSONRPC_INVALID_PARAMS,
      'initialize needs the protocolVersion the client speaks'
    );
  }
  const version = negotiateLegacyVersion(requested);
  const sessionId = startLegacySession(
    userId,
    msg.params.capabilities,
    version
  );
  const response = jsonRpcResult(
    msg.id,
    initializeResult(INSTRUCTIONS, version)
  );
  response.headers.set(SESSION_ID_HEADER, sessionId);
  return response;
}

// `prompts/get` (§10.5 "Prompts"): an unknown prompt or a missing required argument is a
// protocol error, `-32602`, as both revisions' prompts pages say, not a result.
function promptsGet(msg: IncomingMessage, legacy: boolean): Response {
  try {
    return jsonRpcResult(msg.id, promptResult(legacy, getPrompt(msg.params)));
  } catch (error) {
    if (error instanceof PromptRequestError) {
      return jsonRpcError(msg.id, JSONRPC_INVALID_PARAMS, error.message);
    }
    throw error;
  }
}

// 2026-07-28 answers a method the server does not implement with `404 Not Found`, so a client can
// tell it from a missing endpoint by the JSON-RPC body (streamable-http #protocol-version-header);
// a legacy session gets the plain JSON-RPC error.
function unknownMethod(msg: IncomingMessage, legacy: boolean): Response {
  return jsonRpcErrorWithStatus(
    legacy ? HTTP_OK : HTTP_NOT_FOUND,
    msg.id,
    JSONRPC_METHOD_NOT_FOUND,
    `unknown method '${msg.method}'`
  );
}

async function dispatch(
  deps: McpDeps,
  auth: Authenticated,
  msg: IncomingMessage,
  era: Era
): Promise<Response> {
  switch (msg.method) {
    // Current-era `server/discover`: stateless, no session — capabilities travel in each
    // request's `_meta` instead (§10.5).
    case 'server/discover':
      return jsonRpcResult(msg.id, discoverResult(INSTRUCTIONS));
    case 'tools/list':
      return jsonRpcResult(
        msg.id,
        listResult(era.legacy, 'tools', listTools())
      );
    case 'prompts/list':
      return jsonRpcResult(
        msg.id,
        listResult(era.legacy, 'prompts', listPrompts())
      );
    case 'prompts/get':
      return promptsGet(msg, era.legacy);
    case 'tools/call':
      return handleToolsCall(deps, auth, msg, era);
    // 2025-11-25: "The receiver MUST respond promptly with an empty response"
    // (https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping). 2026-07-28
    // removed `ping` (changelog, major change 5), so a current-era one is an unknown method.
    case 'ping':
      return era.legacy
        ? jsonRpcResult(msg.id, {})
        : unknownMethod(msg, era.legacy);
    default:
      return unknownMethod(msg, era.legacy);
  }
}

// `POST /mcp` (§10.5): a mutating tool call runs through `runOperation` with `channel: 'mcp'`,
// so RBAC, confirmation and the audit trail behave exactly as they do for REST.
export async function handleMcpRequest(
  deps: McpDeps,
  request: Request
): Promise<Response> {
  // Before anything else, authentication included: the transport's DNS-rebinding check covers
  // every incoming connection (`./mcp/origin.js`).
  const forbidden = originRejection(request, deps.origin);
  if (forbidden) {
    return forbidden;
  }
  const auth = await authenticate(deps, request);
  if (!auth) {
    return unauthorizedResponse(deps.origin);
  }
  const body = await readJsonBody(request);
  if (body === undefined) {
    return jsonRpcError(null, JSONRPC_PARSE_ERROR, 'invalid JSON');
  }
  const elicitationAnswer = resolveElicitationAnswer(body, auth.actor);
  if (elicitationAnswer) {
    return elicitationAnswer;
  }
  const msg = parseMessage(body);
  if (!msg) {
    return jsonRpcError(
      null,
      JSONRPC_INVALID_REQUEST,
      'invalid JSON-RPC request'
    );
  }
  // `initialize` opens a legacy session whatever else the request carries; every other message
  // is its session's, or a stateless 2026-07-28 one checked before it runs (`./mcp/era.js`).
  if (msg.method === 'initialize' && !msg.isNotification) {
    return legacyInitialize(msg, auth.actor.id);
  }
  const era = resolveEra(request, msg, auth.actor.id);
  if (era instanceof Response) {
    return era;
  }
  if (msg.isNotification) {
    return new Response(null, { status: HTTP_ACCEPTED });
  }
  try {
    const rejection = era.legacy ? null : modernRequestRejection(request, msg);
    return rejection ?? (await dispatch(deps, auth, msg, era));
  } catch (error) {
    // A tool's own refusals are already tool results (`./mcp/toolCall.js`); what reaches here is
    // an unexpected server failure, a protocol-level error that leaks no internals.
    logger.error({ err: error, method: msg.method }, 'mcp: request failed');
    return jsonRpcError(msg.id, JSONRPC_INTERNAL_ERROR, 'internal error');
  }
}
