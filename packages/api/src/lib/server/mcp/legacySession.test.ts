import { describe, expect, it } from 'vitest';

import { epochSeconds } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { signAccessToken } from '#lib/server/auth/jwt.js';
import {
  CLIENT_ID,
  CURRENT,
  JWT_SECRET,
  LEGACY,
  mcpRequest,
  ORIGIN,
  rpc,
  seededDeps,
  type RpcBody
} from '#testing/mcp/testKit.js';
import { legacyRequest, legacySession } from '#testing/mcp/testKitLegacy.js';
import { seedSession } from '#testing/testDb.js';

import { handleMcpRequest, type McpDeps } from '../mcp.js';
import { startLegacySession } from './era.js';

// A legacy session's handshake and the requests that follow it, per
// https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation and
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management.
function initializeBody(params: Record<string, unknown>): unknown {
  return { jsonrpc: '2.0', id: 'init', method: 'initialize', params };
}

function initialize(params: Record<string, unknown>): Request {
  return mcpRequest(initializeBody(params));
}

describe('legacy initialize, version negotiation', () => {
  it('answers with the requested version when the server supports it', async () => {
    const body = await rpc(
      await seededDeps(),
      initialize({ protocolVersion: LEGACY, capabilities: {} })
    );
    expect(body.result?.protocolVersion).toBe(LEGACY);
  });

  it.each(['2025-06-18', '2024-11-05', CURRENT, 'draft'])(
    'answers any other version, here %s, with the latest legacy one it supports',
    async requested => {
      const body = await rpc(
        await seededDeps(),
        initialize({ protocolVersion: requested, capabilities: {} })
      );
      expect(body.result?.protocolVersion).toBe(LEGACY);
    }
  );

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

describe('legacy sessions per user', () => {
  /** Seeds a second user, `user-1`, with a live session; its access token. */
  async function otherUserToken(deps: McpDeps): Promise<string> {
    await seedUser(deps.db, {
      id: 'user-1',
      name: 'User',
      email: 'user@x',
      role: 'user',
      passwordHash: 'x'
    });
    await seedSession(deps.db, 'user-1', CLIENT_ID, 'session-2');
    return signAccessToken(
      JWT_SECRET,
      { sub: 'user-1', role: 'user', cid: CLIENT_ID, sid: 'session-2' },
      epochSeconds(Date.now()),
      ORIGIN
    );
  }

  async function openSession(deps: McpDeps, token?: string): Promise<string> {
    const response = await handleMcpRequest(
      deps,
      mcpRequest(
        initializeBody({ protocolVersion: LEGACY, capabilities: {} }),
        {},
        token
      )
    );
    return response.headers.get('mcp-session-id') ?? '';
  }

  async function status(
    deps: McpDeps,
    sessionId: string,
    token?: string
  ): Promise<number> {
    const request = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'mcp-protocol-version': LEGACY, 'mcp-session-id': sessionId },
      token
    );
    return (await handleMcpRequest(deps, request)).status;
  }

  it("keeps a user's session however many sessions another user opens", async () => {
    const deps = await seededDeps();
    const ownerSession = await openSession(deps);
    const token = await otherUserToken(deps);
    // Past the other user's cap of 10 over the full path, so their own oldest is dropped.
    for (let index = 0; index < 11; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- one initialize after another, as a client restarting would
      await openSession(deps, token);
    }
    // A thousand more straight on the store: as many round trips would time the test by the
    // host's load, and the store is where one user's sessions could evict another's.
    for (let index = 0; index < 1000; index += 1) {
      startLegacySession('user-1', {}, LEGACY);
    }
    expect(await status(deps, ownerSession)).toBe(200);
  });

  it("drops a user's oldest session for a new one past the per-user cap", async () => {
    const deps = await seededDeps();
    const first = await openSession(deps);
    const later: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- sessions open in order, which decides the oldest
      later.push(await openSession(deps));
    }
    expect(await status(deps, first)).toBe(404);
    expect(await status(deps, later[0] ?? '')).toBe(200);
  });

  it("does not serve one user's session to another user", async () => {
    const deps = await seededDeps();
    const ownerSession = await openSession(deps);
    expect(await status(deps, ownerSession, await otherUserToken(deps))).toBe(
      404
    );
  });
});
