import { describe, expect, it } from 'vitest';

import { handleMcpRequest } from '../mcp.js';
import {
  CURRENT,
  currentHeaders,
  currentMeta,
  currentRequest,
  LEGACY,
  mcpRequest,
  seededDeps,
  type RpcBody
} from './testKit.js';
import { legacySession } from './testKitLegacy.js';

// What https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
// ("Request Metadata", "Server Validation"), .../basic#meta and .../basic/versioning require of a
// server receiving a 2026-07-28 request.
const TOOL_CALL = { name: 'test.write', arguments: { value: 'x' } };

/** POSTs a 2026-07-28 request with its `_meta` and headers overridden as each case needs. */
async function send(
  method: string,
  params: Record<string, unknown>,
  options: {
    meta?: Record<string, unknown>;
    headers?: Record<string, string | undefined>;
  } = {}
): Promise<{ status: number; body: RpcBody }> {
  const headers = { ...currentHeaders(method, params), ...options.headers };
  const present = Object.entries(headers).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  );
  const response = await handleMcpRequest(
    await seededDeps(),
    mcpRequest(
      {
        jsonrpc: '2.0',
        id: 7,
        method,
        params: { ...params, _meta: options.meta ?? currentMeta() }
      },
      Object.fromEntries(present)
    )
  );
  return { status: response.status, body: (await response.json()) as RpcBody };
}

function expectRejected(
  outcome: { status: number; body: RpcBody },
  code: number
): void {
  expect(outcome.status).toBe(400);
  expect(outcome.body.id).toBe(7);
  expect(outcome.body.result).toBeUndefined();
  expect(outcome.body.error?.code).toBe(code);
}

describe('2026-07-28 request validation', () => {
  it('serves a request whose _meta and headers agree', async () => {
    const outcome = await send('tools/call', TOOL_CALL);
    expect(outcome.status).toBe(200);
    expect(outcome.body.result).toMatchObject({ isError: false });
  });

  it('rejects a request without the MCP-Protocol-Version header as HeaderMismatch', async () => {
    const outcome = await send(
      'tools/list',
      {},
      {
        headers: { 'mcp-protocol-version': undefined }
      }
    );
    expectRejected(outcome, -32020);
  });

  it('rejects a request missing a required _meta field with -32602', async () => {
    const without = (key: string) =>
      Object.fromEntries(
        Object.entries(currentMeta()).filter(([name]) => name !== key)
      );
    const noVersion = without('io.modelcontextprotocol/protocolVersion');
    const noCaps = without('io.modelcontextprotocol/clientCapabilities');
    expectRejected(await send('tools/list', {}, { meta: noVersion }), -32602);
    expectRejected(await send('tools/list', {}, { meta: noCaps }), -32602);
  });

  it('rejects a version header that does not match _meta as HeaderMismatch', async () => {
    const outcome = await send(
      'tools/list',
      {},
      {
        headers: { 'mcp-protocol-version': LEGACY }
      }
    );
    expectRejected(outcome, -32020);
  });

  it('rejects a version it does not speak, listing the ones it does', async () => {
    const outcome = await send(
      'tools/list',
      {},
      {
        meta: {
          ...currentMeta(),
          'io.modelcontextprotocol/protocolVersion': '1900-01-01'
        },
        headers: { 'mcp-protocol-version': '1900-01-01' }
      }
    );
    expectRejected(outcome, -32022);
    expect(outcome.body.error).toEqual({
      code: -32022,
      message: 'Unsupported protocol version',
      data: { supported: [CURRENT, LEGACY], requested: '1900-01-01' }
    });
  });

  it('rejects a missing or mismatched Mcp-Method header as HeaderMismatch', async () => {
    expectRejected(
      await send('tools/list', {}, { headers: { 'mcp-method': undefined } }),
      -32020
    );
    expectRejected(
      await send(
        'tools/list',
        {},
        { headers: { 'mcp-method': 'prompts/list' } }
      ),
      -32020
    );
  });

  it('rejects a missing, mismatched or malformed Mcp-Name header as HeaderMismatch', async () => {
    for (const name of [undefined, 'test.delete', '=?base64?not base64?=']) {
      // eslint-disable-next-line no-await-in-loop -- each header value is its own request
      const outcome = await send('tools/call', TOOL_CALL, {
        headers: { 'mcp-name': name }
      });
      expectRejected(outcome, -32020);
    }
    expectRejected(
      await send(
        'prompts/get',
        { name: 'undo' },
        {
          headers: { 'mcp-name': 'onboard-employee' }
        }
      ),
      -32020
    );
  });

  it('decodes a Base64-sentinel Mcp-Name before comparing it', async () => {
    const encoded = Buffer.from('test.write', 'utf8').toString('base64');
    const outcome = await send('tools/call', TOOL_CALL, {
      headers: { 'mcp-name': `=?base64?${encoded}?=` }
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body.result).toMatchObject({ isError: false });
  });

  it('answers a method it does not implement with 404 and -32601', async () => {
    const outcome = await send('resources/list', {});
    expect(outcome.status).toBe(404);
    expect(outcome.body.error?.code).toBe(-32601);
  });

  it('treats a request with neither _meta nor a legacy session as a malformed 2026-07-28 one', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as RpcBody).error?.code).toBe(-32020);
  });

  it('serves a request carrying 2026-07-28 _meta statelessly, whatever session id it also carries', async () => {
    const deps = await seededDeps();
    const legacy = await legacySession(deps, { elicitation: {} });
    const request = currentRequest(1, 'tools/list');
    request.headers.set('mcp-session-id', legacy['mcp-session-id'] ?? '');
    const body = (await (
      await handleMcpRequest(deps, request)
    ).json()) as RpcBody;
    expect(body.result).toMatchObject({ resultType: 'complete' });
  });
});
