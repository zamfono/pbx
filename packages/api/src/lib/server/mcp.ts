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
import { ISSUES_BUDGET_BYTES } from './problem.js';
import { MAX_BODY_BYTES } from './requestBody.js';

export type { McpDeps } from './mcp/auth.js';

// `legacy: 'reject'`: 2026-07-28 is the one revision served (§10.5), so a 2025-era `initialize` is
// refused as an unsupported version.
const handler = createMcpHandler(mcpServer, {
  legacy: 'reject',
  maxRequestBodySize: MAX_BODY_BYTES
});

type RpcError = { code: number; message: string; data?: unknown };
type RpcBody = {
  error?: RpcError;
  result?: { isError?: boolean; content?: { type: string; text?: string }[] };
};

// The most bytes of JSON one character of a message can take: `\u001f`.
const MAX_CHAR_BYTES = 6;
// The most characters of a refusal's message kept.
const MESSAGE_CHARS = Math.floor(ISSUES_BUDGET_BYTES / MAX_CHAR_BYTES);

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

/**
 * `text` and `note` in at most `room` bytes of JSON and at most `cap` characters of `text`: whole
 * where it fits, else cut to its first characters that do, the count of those left out appended.
 */
function cut(text: string, room: number, cap: number, note = ''): string {
  if (text.length <= cap && jsonBytes(text + note) <= room) {
    return text + note;
  }
  // The note's count has no more digits than the whole length.
  const tail = `… ${text.length} more characters left out${note}`;
  const kept = Math.max(
    0,
    Math.min(cap, Math.floor((room - jsonBytes(tail)) / MAX_CHAR_BYTES))
  );
  return `${text.slice(0, kept)}… ${text.length - kept} more characters left out${note}`;
}

/**
 * `body` with `text` cut by `cut` and written back by `set`, so that the whole response, its echoed
 * `id` included, takes at most `MAX_BODY_BYTES`.
 */
function fitted(
  body: RpcBody,
  text: string,
  set: (body: RpcBody, text: string) => RpcBody,
  cap: number,
  note = ''
): RpcBody {
  const room = MAX_BODY_BYTES - jsonBytes(set(body, '')) + jsonBytes('');
  return set(body, cut(text, room, cap, note));
}

/**
 * `response` with a JSON-RPC error past a quarter of the request body limit cut down to fit it:
 * its message to the first `MESSAGE_CHARS` characters, the count of those left out appended, and
 * its `data` left out, so that no refusal is larger than a request may be (§10.5). The SDK
 * refuses an invalid request before any handler runs, listing every issue of its own validation
 * or quoting the value it refused, as JSON, never in a stream, which only a running handler opens.
 * The response echoes the request's `id`, of any length, so a refusal, the error or a tool's
 * refusal of its arguments, is cut further where the whole would exceed the limit.
 */
async function boundedRefusal(response: Response): Promise<Response> {
  if (response.headers.get('content-type') !== 'application/json') {
    return response;
  }
  const text = await response.text();
  const size = Buffer.byteLength(text);
  if (size <= ISSUES_BUDGET_BYTES) {
    return new Response(text, response);
  }
  const body = JSON.parse(text) as RpcBody;
  const { error, result } = body;
  if (
    error !== undefined &&
    (size > MAX_BODY_BYTES || jsonBytes(error) > ISSUES_BUDGET_BYTES)
  ) {
    return Response.json(
      fitted(
        body,
        error.message,
        (shell, message) => ({
          ...shell,
          error: { code: error.code, message }
        }),
        MESSAGE_CHARS,
        error.data === undefined ? '' : ' (its data left out)'
      ),
      response
    );
  }
  const only = result?.content?.length === 1 ? result.content[0] : undefined;
  if (
    size > MAX_BODY_BYTES &&
    result?.isError === true &&
    only?.text !== undefined
  ) {
    return Response.json(
      fitted(
        body,
        only.text,
        (shell, refusal) => ({
          ...shell,
          result: { ...result, content: [{ ...only, text: refusal }] }
        }),
        Infinity
      ),
      response
    );
  }
  return new Response(text, response);
}

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
  return boundedRefusal(await handler.fetch(request, { authInfo }));
}
