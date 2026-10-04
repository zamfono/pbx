// The 2025-11-25 era's side of the MCP test fixtures (`testKit.ts`): a session opened with
// `initialize`, its requests, and the SSE events a response streams.

import { handleMcpRequest, type McpDeps } from '#lib/server/mcp.js';

import { LEGACY, mcpRequest } from './testKit.js';

const SSE_SEPARATOR = '\n\n';

/** Opens a legacy session and returns the headers every later request of it carries. */
export async function legacySession(
  deps: McpDeps,
  capabilities: Record<string, unknown> = {}
): Promise<Record<string, string>> {
  const init = await handleMcpRequest(
    deps,
    mcpRequest({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: LEGACY,
        capabilities,
        clientInfo: { name: 'test', version: '1' }
      }
    })
  );
  return {
    'mcp-protocol-version': LEGACY,
    'mcp-session-id': init.headers.get('mcp-session-id') ?? ''
  };
}

export function legacyRequest(
  headers: Record<string, string>,
  id: number,
  method: string,
  params: Record<string, unknown> = {}
): Request {
  return mcpRequest({ jsonrpc: '2.0', id, method, params }, headers);
}

/** Reads newline-delimited `data: <json>` SSE events off a Streamable HTTP response one at a time. */
export async function* readSseEvents(response: Response): AsyncGenerator {
  const body = response.body;
  if (!body) {
    throw new Error('SSE response has no body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let separator = buffer.indexOf(SSE_SEPARATOR);
    while (separator === -1) {
      // eslint-disable-next-line no-await-in-loop -- one stream reader, reads are inherently sequential
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      separator = buffer.indexOf(SSE_SEPARATOR);
    }
    const raw = buffer.slice(0, separator);
    buffer = buffer.slice(separator + SSE_SEPARATOR.length);
    yield JSON.parse(raw.replace(/^data: /u, ''));
  }
}
