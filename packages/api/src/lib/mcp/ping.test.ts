import { describe, expect, it } from 'vitest';

import { handleMcpRequest } from '../mcp.js';
import {
  currentRequest,
  legacyRequest,
  legacySession,
  seededDeps,
  type RpcBody
} from './testKit.js';

// `ping` exists in 2025-11-25 only
// (https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping); 2026-07-28
// removed it (https://modelcontextprotocol.io/specification/2026-07-28/changelog, major change 5).
describe('ping', () => {
  it('answers a legacy session with the empty result', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const response = await handleMcpRequest(
      deps,
      legacyRequest(headers, 7, 'ping')
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {}
    });
  });

  it('answers a 2026-07-28 request as an unknown method', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      currentRequest(8, 'ping')
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as RpcBody).error?.code).toBe(-32601);
  });
});
