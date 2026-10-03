import process from 'node:process';
import { z } from 'zod';

import { epochSeconds, HTTP_CONFLICT, nowIso } from '@zamfono/shared';

import { signAccessToken } from '../auth/jwtSigning.js';
import { handleMcpRequest, type McpDeps } from '../mcp.js';
import { register } from '../ops/registry.js';
import { defineOperation } from '../ops/types.js';
import { makeTestDb } from '../testDb.js';
import { serverInfo } from './results.js';

// Fixtures the MCP endpoint's tests share (`../mcp.test.ts` and the focused `*.test.ts` beside
// it): the test operations, a seeded database, and requests shaped as each protocol era sends
// them — https://modelcontextprotocol.io/specification/2026-07-28 for a stateless request,
// https://modelcontextprotocol.io/specification/2025-11-25 for a session opened with
// `initialize`. Importing it registers the operations, once per test file.
export const ORIGIN = 'https://pbx.example';
export const JWT_SECRET = 'test-secret';
export const CLIENT_ID = 'client-1';
const CLIENT_NAME = 'Ops Console';
export const CURRENT = '2026-07-28';
export const LEGACY = '2025-11-25';

register(
  defineOperation<{ value: string }, { id: string; value: string }>({
    name: 'test.write',
    description: 'writes a thing',
    input: z.object({ value: z.string() }),
    minRole: 'user',
    entity: (_input, out) => ({ kind: 'test', id: out.id }),
    run: (_ctx, input) => Promise.resolve({ id: 'w1', value: input.value })
  })
);
register(
  defineOperation<{ id: string }, { deleted: string }>({
    name: 'test.delete',
    description: 'deletes a thing',
    input: z.object({ id: z.string() }).strict(),
    minRole: 'user',
    confirm: input => `Delete ${input.id}?`,
    entity: input => ({ kind: 'test', id: input.id }),
    run: (_ctx, input) => Promise.resolve({ deleted: input.id })
  })
);
register(
  defineOperation<Record<string, never>, string[]>({
    name: 'test.names',
    description: 'lists names',
    input: z.object({}),
    minRole: 'user',
    readOnly: true,
    run: () => Promise.resolve(['a', 'b'])
  })
);
register(
  defineOperation<Record<string, never>, never>({
    name: 'test.crash',
    description: 'fails unexpectedly',
    input: z.object({}),
    minRole: 'user',
    readOnly: true,
    run: () => Promise.reject(new Error('database on fire'))
  })
);

/** The owner's access token, signed once per test file, which ends well within its 15 minutes. */
export const OWNER_TOKEN = await signAccessToken(
  JWT_SECRET,
  { sub: 'owner', role: 'owner', cid: CLIENT_ID },
  epochSeconds(Date.now()),
  ORIGIN
);

export function mcpRequest(
  body: unknown,
  headers: Record<string, string> = {},
  token = OWNER_TOKEN
): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

/** The `_meta` a 2026-07-28 request carries: version, client info and capabilities. */
export function currentMeta(
  capabilities: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': CURRENT,
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': capabilities
  };
}

/** The standard headers a 2026-07-28 request mirrors from its body: `MCP-Protocol-Version`,
 * `Mcp-Method`, and `Mcp-Name` for a request that names its target. */
export function currentHeaders(
  method: string,
  params: Record<string, unknown> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    'mcp-protocol-version': CURRENT,
    'mcp-method': method
  };
  if (typeof params.name === 'string') {
    headers['mcp-name'] = params.name;
  }
  return headers;
}

/** A 2026-07-28 request, its `_meta` and standard headers as a conforming client sends them. */
export function currentRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {}
): Request {
  return mcpRequest(
    {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: currentMeta(capabilities) }
    },
    currentHeaders(method, params)
  );
}

export async function seededDeps(): Promise<McpDeps> {
  const db = await makeTestDb();
  await db
    .insertInto('oauthClients')
    .values({
      clientId: CLIENT_ID,
      name: CLIENT_NAME,
      kind: 'cimd',
      redirectUrisJson: '[]',
      createdAt: nowIso(),
      lastLoginAt: nowIso()
    })
    .execute();
  return { db, jwtSecret: JWT_SECRET, origin: ORIGIN };
}

export type RpcBody = {
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export async function rpc(deps: McpDeps, request: Request): Promise<RpcBody> {
  return (await (await handleMcpRequest(deps, request)).json()) as RpcBody;
}

// `results.ts`'s own `SERVER_INFO`, from the test process's environment (`serverInfo` itself is
// covered by `results.test.ts`).
export const SERVER_INFO_META = {
  'io.modelcontextprotocol/serverInfo': serverInfo(process.env)
};

/** A 2026-07-28 `CallToolResult` whose value is `value`, serialised and structured. */
export function currentToolResult(value: unknown, isError = false): object {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
    _meta: SERVER_INFO_META
  };
}

/** The REST `confirmationRequired` problem (§10.3) a confirm-guarded tool reports. */
export const confirmationProblem = (
  question: string
): Record<string, unknown> => ({
  status: HTTP_CONFLICT,
  title: 'confirmation required',
  confirmationRequired: true,
  question
});
