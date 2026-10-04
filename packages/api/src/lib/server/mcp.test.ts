import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { epochSeconds, nowIso } from '@zamfono/shared';

import {
  CLIENT_ID,
  confirmationProblem,
  CURRENT,
  currentRequest,
  currentToolResult,
  JWT_SECRET,
  LEGACY,
  mcpRequest,
  ORIGIN,
  rpc,
  seededDeps,
  SERVER_INFO_META,
  type RpcBody
} from '#testing/mcp/testKit.js';
import {
  legacyRequest,
  legacySession,
  readSseEvents
} from '#testing/mcp/testKitLegacy.js';

import { signAccessToken } from './auth/jwt.js';
import { handleMcpRequest } from './mcp.js';
import { protectedResourceMetadata } from './mcp/auth.js';
import { callHelp } from './mcp/guide.js';

// The result shapes below are asserted field by field against the MCP schema of the era the
// request speaks: https://modelcontextprotocol.io/specification/2026-07-28/schema for a
// stateless request, https://modelcontextprotocol.io/specification/2025-11-25/schema for a
// session opened with `initialize`. The fixtures, test operations included, are `./mcp/testKit.js`.
const MAX_INSTRUCTIONS_LENGTH = 512;

describe('handleMcpRequest, 2026-07-28', () => {
  it('answers server/discover with a DiscoverResult', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(1, 'server/discover')
    );
    expect(body.result).toEqual({
      resultType: 'complete',
      supportedVersions: [CURRENT, LEGACY],
      capabilities: { tools: {}, prompts: {} },
      instructions: expect.any(String) as string,
      ttlMs: expect.any(Number) as number,
      cacheScope: 'private',
      _meta: SERVER_INFO_META
    });
  });

  it('lists tools under `tools`, hints under `annotations`, sorted and stable', async () => {
    const deps = await seededDeps();
    const first = await rpc(deps, currentRequest(1, 'tools/list'));
    const second = await rpc(deps, currentRequest(2, 'tools/list'));
    expect(first.result).toEqual({
      resultType: 'complete',
      tools: expect.any(Array) as unknown[],
      ttlMs: expect.any(Number) as number,
      cacheScope: 'private',
      _meta: SERVER_INFO_META
    });
    const tools = first.result?.tools as Record<string, unknown>[];
    expect(tools.find(tool => tool.name === 'test.delete')).toEqual({
      name: 'test.delete',
      description: 'deletes a thing',
      inputSchema: expect.objectContaining({ type: 'object' }) as object,
      outputSchema: expect.objectContaining({ type: 'object' }) as object,
      annotations: { readOnlyHint: false, destructiveHint: true }
    });
    expect(tools.find(tool => tool.name === 'zamfono.help')).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false }
    });
    // MCP fixes an output schema to an object, so a tool answering with a list has none.
    expect(tools.find(tool => tool.name === 'test.names')).not.toHaveProperty(
      'outputSchema'
    );
    const names = tools.map(tool => tool.name as string);
    // Code-point order, not `localeCompare`: it must not depend on the container's ICU locale.
    expect(names).toEqual([...names].sort());
    expect(second.result?.tools).toEqual(tools);
  });

  it('lists prompts under `prompts`', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(1, 'prompts/list')
    );
    expect(body.result).toEqual({
      resultType: 'complete',
      prompts: expect.any(Array) as unknown[],
      ttlMs: expect.any(Number) as number,
      cacheScope: 'private',
      _meta: SERVER_INFO_META
    });
  });

  it('returns a tool call as content and structuredContent, audited with channel mcp', async () => {
    const deps = await seededDeps();
    const body = await rpc(
      deps,
      currentRequest(2, 'tools/call', {
        name: 'test.write',
        arguments: { value: 'x' }
      })
    );
    expect(body.result).toEqual(currentToolResult({ id: 'w1', value: 'x' }));
    const row = await deps.db
      .selectFrom('auditLog')
      .select(['channel', 'clientId'])
      .where('operation', '=', 'test.write')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ channel: 'mcp', clientId: CLIENT_ID });
  });

  it('carries a non-object output as structuredContent too', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(2, 'tools/call', { name: 'test.names', arguments: {} })
    );
    expect(body.result).toEqual(currentToolResult(['a', 'b']));
  });

  it('reports invalid arguments as a tool execution error, not a JSON-RPC error', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(3, 'tools/call', {
        name: 'test.write',
        arguments: { value: 5 }
      })
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({
      resultType: 'complete',
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('validation failed') as string
        }
      ],
      structuredContent: { status: 422, title: 'validation failed' }
    });
  });

  it('reports an unknown help topic as a tool execution error', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(3, 'tools/call', {
        name: 'zamfono.help',
        arguments: { topic: 'no-such-topic' }
      })
    );
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        status: 404,
        // The client learns from the error itself how to find the topics, and which there are.
        title: expect.stringMatching(
          /call zamfono\.help without a topic for the list: .*\bnumbers\b/u
        ) as string
      }
    });
  });

  it('answers an unknown tool, or a call without a name, with JSON-RPC -32602', async () => {
    const deps = await seededDeps();
    const unknown = await rpc(
      deps,
      currentRequest(4, 'tools/call', { name: 'no.such', arguments: {} })
    );
    expect(unknown.result).toBeUndefined();
    expect(unknown.error).toEqual({
      code: -32602,
      message: 'Unknown tool: no.such'
    });
    const nameless = await rpc(deps, currentRequest(5, 'tools/call', {}));
    expect(nameless.error?.code).toBe(-32602);
  });

  it('answers an unexpected failure with JSON-RPC -32603, leaking nothing', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(6, 'tools/call', { name: 'test.crash', arguments: {} })
    );
    expect(body.error).toEqual({ code: -32603, message: 'internal error' });
  });

  it('mirrors the REST confirmation contract when the client lacks elicitation', async () => {
    const deps = await seededDeps();
    const call = (args: Record<string, unknown>) =>
      rpc(
        deps,
        currentRequest(3, 'tools/call', {
          name: 'test.delete',
          arguments: args
        })
      );
    expect((await call({ id: 't1' })).result).toEqual(
      currentToolResult(confirmationProblem('Delete t1?'), true)
    );
    expect((await call({ id: 't1', confirm: true })).result).toEqual(
      currentToolResult({ deleted: 't1' })
    );
  });

  it('elicits inline as input_required, running on accept and mirroring REST on decline', async () => {
    const deps = await seededDeps();
    const call = (inputResponses?: Record<string, unknown>) =>
      rpc(
        deps,
        currentRequest(
          4,
          'tools/call',
          {
            name: 'test.delete',
            arguments: { id: 't2' },
            ...(inputResponses ? { inputResponses } : {})
          },
          // Object form, as MCP clients declare capabilities on the wire.
          { elicitation: {} }
        )
      );
    expect((await call()).result).toEqual({
      resultType: 'input_required',
      inputRequests: {
        confirm: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Delete t2?',
            requestedSchema: {
              type: 'object',
              properties: { confirm: { type: 'boolean' } },
              required: ['confirm']
            }
          }
        }
      },
      _meta: SERVER_INFO_META
    });
    const accepted = await call({
      confirm: { action: 'accept', content: { confirm: true } }
    });
    expect(accepted.result).toEqual(currentToolResult({ deleted: 't2' }));
    for (const answer of [
      { action: 'accept', content: { confirm: false } },
      { action: 'decline' },
      { action: 'cancel' }
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each answer is its own retry of the call
      const refused = await call({ confirm: answer });
      expect(refused.result).toEqual(
        currentToolResult(confirmationProblem('Delete t2?'), true)
      );
    }
  });

  it('accepts the boolean and form forms of the elicitation capability, not URL mode alone', async () => {
    const deps = await seededDeps();
    const resultTypeFor = async (elicitation: unknown) => {
      const body = await rpc(
        deps,
        currentRequest(
          6,
          'tools/call',
          { name: 'test.delete', arguments: { id: 't4' } },
          { elicitation }
        )
      );
      return [body.result?.resultType, body.result?.isError];
    };
    expect(await resultTypeFor(true)).toEqual(['input_required', undefined]);
    expect(await resultTypeFor({ form: {} })).toEqual([
      'input_required',
      undefined
    ]);
    expect(await resultTypeFor({ url: {} })).toEqual(['complete', true]);
  });
});

describe('handleMcpRequest, legacy 2025-11-25', () => {
  it('answers initialize with an InitializeResult and a session id', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      mcpRequest({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: { protocolVersion: LEGACY, capabilities: {} }
      })
    );
    expect(response.headers.get('mcp-session-id')).toBeTruthy();
    const body = (await response.json()) as RpcBody;
    expect(body.result).toEqual({
      protocolVersion: LEGACY,
      capabilities: { tools: {}, prompts: {} },
      serverInfo: SERVER_INFO_META['io.modelcontextprotocol/serverInfo'],
      instructions: expect.any(String) as string
    });
  });

  it('lists tools and prompts in the 2025-11-25 shape, without 2026-07-28 fields', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const tools = await rpc(deps, legacyRequest(headers, 1, 'tools/list'));
    expect(tools.result).toEqual({ tools: expect.any(Array) as unknown[] });
    const listed = tools.result?.tools as Record<string, unknown>[];
    expect(listed.find(tool => tool.name === 'test.write')).toEqual({
      name: 'test.write',
      description: 'writes a thing',
      inputSchema: expect.objectContaining({ type: 'object' }) as object,
      outputSchema: expect.objectContaining({ type: 'object' }) as object,
      annotations: { readOnlyHint: false, destructiveHint: false }
    });
    const prompts = await rpc(deps, legacyRequest(headers, 2, 'prompts/list'));
    expect(prompts.result).toEqual({ prompts: expect.any(Array) as unknown[] });
  });

  it('returns a tool call as a 2025-11-25 CallToolResult', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const body = await rpc(
      deps,
      legacyRequest(headers, 3, 'tools/call', {
        name: 'test.write',
        arguments: { value: 'y' }
      })
    );
    expect(body.result).toEqual({
      content: [{ type: 'text', text: '{"id":"w1","value":"y"}' }],
      structuredContent: { id: 'w1', value: 'y' },
      isError: false
    });
  });

  it('carries a non-object output as text only, since structuredContent must be an object', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const body = await rpc(
      deps,
      legacyRequest(headers, 3, 'tools/call', {
        name: 'test.names',
        arguments: {}
      })
    );
    expect(body.result).toEqual({
      content: [{ type: 'text', text: '["a","b"]' }],
      isError: false
    });
  });

  it('reports a tool execution error with isError and the confirmation contract as REST does', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const invalid = await rpc(
      deps,
      legacyRequest(headers, 4, 'tools/call', {
        name: 'test.write',
        arguments: {}
      })
    );
    expect(invalid.result).toMatchObject({
      isError: true,
      structuredContent: { status: 422 }
    });
    const unconfirmed = await rpc(
      deps,
      legacyRequest(headers, 5, 'tools/call', {
        name: 'test.delete',
        arguments: { id: 't6' }
      })
    );
    expect(unconfirmed.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(confirmationProblem('Delete t6?'))
        }
      ],
      structuredContent: confirmationProblem('Delete t6?'),
      isError: true
    });
  });

  it('asks an elicitation-capable client with a server-initiated elicitation/create', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps, { elicitation: {} });
    const response = await handleMcpRequest(
      deps,
      legacyRequest(headers, 5, 'tools/call', {
        name: 'test.delete',
        arguments: { id: 't3' }
      })
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const events = readSseEvents(response);
    const elicit = (await events.next()).value as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(elicit.method).toBe('elicitation/create');
    expect(elicit.params).toEqual({
      mode: 'form',
      message: 'Delete t3?',
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean' } },
        required: ['confirm']
      }
    });

    const answered = await handleMcpRequest(
      deps,
      mcpRequest({
        jsonrpc: '2.0',
        id: elicit.id,
        result: { action: 'accept', content: { confirm: true } }
      })
    );
    expect(answered.status).toBe(202);

    const settled = (await events.next()).value as RpcBody;
    expect(settled.id).toBe(5);
    expect(settled.result).toEqual({
      content: [{ type: 'text', text: '{"deleted":"t3"}' }],
      structuredContent: { deleted: 't3' },
      isError: false
    });
  });

  it('mirrors the REST confirmation contract when the legacy client declines', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps, { elicitation: {} });
    const response = await handleMcpRequest(
      deps,
      legacyRequest(headers, 8, 'tools/call', {
        name: 'test.delete',
        arguments: { id: 't7' }
      })
    );
    const events = readSseEvents(response);
    const elicit = (await events.next()).value as { id: string };
    await handleMcpRequest(
      deps,
      mcpRequest({
        jsonrpc: '2.0',
        id: elicit.id,
        result: { action: 'decline' }
      })
    );
    const settled = (await events.next()).value as RpcBody;
    expect(settled.result).toMatchObject({
      isError: true,
      structuredContent: confirmationProblem('Delete t7?')
    });
  });

  it('leaves an elicitation pending when a different actor answers it', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps, { elicitation: true });
    const response = await handleMcpRequest(
      deps,
      legacyRequest(headers, 7, 'tools/call', {
        name: 'test.delete',
        arguments: { id: 't5' }
      })
    );
    const events = readSseEvents(response);
    const elicit = (await events.next()).value as { id: string };

    const otherActorToken = await signAccessToken(
      JWT_SECRET,
      { sub: 'someone-else', role: 'owner', cid: CLIENT_ID },
      epochSeconds(Date.now()),
      ORIGIN
    );
    await deps.db
      .insertInto('users')
      .values({
        id: 'someone-else',
        name: 'Someone Else',
        email: 'someone-else@x',
        role: 'owner',
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
    const wrongActorAnswer = await handleMcpRequest(
      deps,
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: elicit.id,
          result: { action: 'accept', content: { confirm: true } }
        },
        {},
        otherActorToken
      )
    );
    expect(wrongActorAnswer.status).toBe(200);
    const wrongActorBody = (await wrongActorAnswer.json()) as RpcBody;
    expect(wrongActorBody.error).toEqual({
      code: -32600,
      message: 'invalid JSON-RPC request'
    });
  });
});

describe('handleMcpRequest, JSON-RPC framing', () => {
  it('answers a JSON-RPC notification with 202 and no body', async () => {
    const deps = await seededDeps();
    const response = await handleMcpRequest(
      deps,
      mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('answers a body that is not JSON with -32700 and an unknown method with -32601', async () => {
    const deps = await seededDeps();
    expect((await rpc(deps, mcpRequest('{not json'))).error?.code).toBe(-32700);
    expect((await rpc(deps, currentRequest(9, 'no/such'))).error?.code).toBe(
      -32601
    );
  });
});

describe('protectedResourceMetadata', () => {
  it('points at the stack’s own authorization server', () => {
    expect(protectedResourceMetadata(ORIGIN)).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN]
    });
  });
});

/** The literal topic names instructions.txt lists in its "topic (…)" parenthetical, dropping the
 * trailing "or a recipe name" placeholder, which names no single file. */
function namedHelpTopics(instructions: string): string[] {
  const parenthetical = /topic \((?<list>[^)]+)\)/u.exec(instructions);
  const list = parenthetical?.groups?.list;
  const names = list === undefined ? [] : list.split(',');
  return names.map(name => name.trim()).filter(name => !name.startsWith('or '));
}

describe('instructions.txt', () => {
  it('is under 512 characters', () => {
    const text = readFileSync(
      new URL('./mcp/instructions.txt', import.meta.url),
      'utf8'
    ).trim();
    expect(text.length).toBeLessThan(MAX_INSTRUCTIONS_LENGTH);
  });

  it('names only topics that resolve to a guide file', () => {
    const text = readFileSync(
      new URL('./mcp/instructions.txt', import.meta.url),
      'utf8'
    );
    const topics = namedHelpTopics(text);
    expect(topics).not.toHaveLength(0);
    for (const topic of topics) {
      expect(callHelp({ topic })).toHaveProperty('content');
    }
  });
});
