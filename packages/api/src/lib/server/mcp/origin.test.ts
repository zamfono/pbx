import { describe, expect, it } from 'vitest';

import {
  currentHeaders,
  currentMeta,
  mcpRequest,
  ORIGIN,
  OWNER_TOKEN,
  seededDeps
} from '#testing/mcp/testKit.js';
import { legacyRequest, legacySession } from '#testing/mcp/testKitLegacy.js';

import { handleMcpRequest } from '../mcp.js';

// The Streamable HTTP transport's DNS-rebinding check, the same in both revisions
// (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-%26-endpoint,
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning).
function discoverFrom(origin: string | null, token = OWNER_TOKEN): Request {
  return mcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: currentMeta() }
    },
    {
      ...currentHeaders('server/discover'),
      ...(origin === null ? {} : { origin })
    },
    token
  );
}

describe('Origin validation', () => {
  it('refuses a foreign Origin with 403 and a JSON-RPC error that has no id', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      discoverFrom('https://attacker.example')
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Origin not allowed' }
    });
    expect('id' in body).toBe(false);
  });

  it('refuses the opaque Origin `null` a sandboxed page sends', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      discoverFrom('null')
    );
    expect(response.status).toBe(403);
  });

  it('refuses a foreign Origin before looking at the token', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      discoverFrom('https://attacker.example', 'not-a-token')
    );
    expect(response.status).toBe(403);
  });

  it('refuses a foreign Origin on a legacy session too', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const response = await handleMcpRequest(
      deps,
      legacyRequest(
        { ...headers, origin: 'http://127.0.0.1:8080' },
        2,
        'tools/list'
      )
    );
    expect(response.status).toBe(403);
  });

  it("serves a request from the stack's own origin", async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      discoverFrom(ORIGIN)
    );
    expect(response.status).toBe(200);
  });

  it('serves a request without Origin, as non-browser clients send it', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      discoverFrom(null)
    );
    expect(response.status).toBe(200);
  });
});
