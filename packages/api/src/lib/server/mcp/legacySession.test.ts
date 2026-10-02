import { describe, expect, it } from 'vitest';

import { handleMcpRequest } from '../mcp.js';
import {
  CURRENT,
  LEGACY,
  mcpRequest,
  rpc,
  seededDeps,
  type RpcBody
} from './testKit.js';
import { legacyRequest, legacySession } from './testKitLegacy.js';

// A legacy session's handshake and the requests that follow it, per
// https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation and
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management.
function initialize(params: Record<string, unknown>): Request {
  return mcpRequest({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params
  });
}

describe('legacy initialize, version negotiation', () => {
  it('answers with the requested version when the server supports it', async () => {
    const body = await rpc(
      await seededDeps(),
      initialize({ protocolVersion: LEGACY, capabilities: {} })
    );
    expect(body.result?.protocolVersion).toBe(LEGACY);
  });

  it('answers any other version with the latest legacy one it supports', async () => {
    const deps = await seededDeps();
    for (const requested of ['2025-06-18', '2024-11-05', CURRENT, 'draft']) {
      // eslint-disable-next-line no-await-in-loop -- each version is its own handshake
      const body = await rpc(
        deps,
        initialize({ protocolVersion: requested, capabilities: {} })
      );
      expect(body.result?.protocolVersion).toBe(LEGACY);
    }
  });

  it('answers an initialize without a protocolVersion with -32602 and no session', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      initialize({ capabilities: {} })
    );
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as RpcBody;
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
  });
});

describe('legacy session requests', () => {
  it('serves a request without MCP-Protocol-Version in the version its session negotiated', async () => {
    const deps = await seededDeps();
    const { 'mcp-session-id': sessionId = '' } = await legacySession(deps);
    const body = await rpc(
      deps,
      legacyRequest({ 'mcp-session-id': sessionId }, 1, 'tools/list')
    );
    expect(body.result).toEqual({ tools: expect.any(Array) as unknown[] });
  });

  it('rejects an MCP-Protocol-Version other than the negotiated one with 400', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const response = await handleMcpRequest(
      deps,
      legacyRequest(
        { ...headers, 'mcp-protocol-version': '2025-06-18' },
        2,
        'tools/list'
      )
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as RpcBody).result).toBeUndefined();
  });

  it('rejects a session this process does not hold with 404, so the client initializes again', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      legacyRequest(
        { 'mcp-protocol-version': LEGACY, 'mcp-session-id': 'gone' },
        3,
        'tools/list'
      )
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as RpcBody).error?.code).toBe(-32600);
  });

  it('rejects a legacy request without Mcp-Session-Id with 400', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      legacyRequest({ 'mcp-protocol-version': LEGACY }, 4, 'tools/list')
    );
    expect(response.status).toBe(400);
  });

  it('checks the session of a notification too', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      mcpRequest(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { 'mcp-protocol-version': LEGACY, 'mcp-session-id': 'gone' }
      )
    );
    expect(response.status).toBe(404);
  });
});
