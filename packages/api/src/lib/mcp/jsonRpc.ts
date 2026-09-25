// The JSON-RPC 2.0 framing every MCP message travels in (§10.5): parsing an incoming request off
// the Streamable HTTP body, and wrapping a result or an error back into a response.
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
const STATUS_OK = 200;
// 2026-07-28 carries the protocol version and the client's capabilities per request, in
// `params._meta` under these keys (https://modelcontextprotocol.io/specification/2026-07-28/basic#meta).
export const PROTOCOL_VERSION_META_KEY =
  'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities';

export type JsonRpcId = string | number | null;

export type IncomingMessage = {
  id: JsonRpcId;
  isNotification: boolean;
  method: string;
  params: Record<string, unknown>;
  /** `declaresVersion`: the version key is present at all, the mark of a 2026-07-28 request
   * even when its value is malformed; `protocolVersion`: that value, when it is a string. */
  meta: {
    declaresVersion: boolean;
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
  };
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** `req.json()`, or `undefined` when the body is not valid JSON. */
export async function attemptJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function parseMessage(body: unknown): IncomingMessage | null {
  const record = asRecord(body);
  if (!record || typeof record.method !== 'string') {
    return null;
  }
  const id = record.id;
  const params = asRecord(record.params) ?? {};
  // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket access avoids no-underscore-dangle on `_meta`
  const meta = asRecord(params['_meta']) ?? {};
  const version = meta[PROTOCOL_VERSION_META_KEY];
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    // JSON-RPC 2.0 §4.1: a notification has no `id` member at all, distinct from an explicit
    // `id: null`, and must receive no reply.
    isNotification: !('id' in record),
    method: record.method,
    params,
    meta: {
      declaresVersion: PROTOCOL_VERSION_META_KEY in meta,
      protocolVersion: typeof version === 'string' ? version : undefined,
      capabilities: asRecord(meta[CLIENT_CAPABILITIES_META_KEY]) ?? undefined
    }
  };
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

/** A JSON-RPC error on an HTTP status other than 200, where the transport names one (a
 * 2026-07-28 request the server rejects before running it answers 400 or 404). */
export function jsonRpcErrorWithStatus(
  status: number,
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): Response {
  const error =
    data === undefined ? { code, message } : { code, message, data };
  return Response.json({ jsonrpc: '2.0', id, error }, { status });
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): Response {
  return jsonRpcErrorWithStatus(STATUS_OK, id, code, message, data);
}
