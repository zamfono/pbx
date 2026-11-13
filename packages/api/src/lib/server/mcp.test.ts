import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CLIENT_ID,
  confirmationProblem,
  CURRENT,
  currentHeaders,
  currentMeta,
  currentRequest,
  currentToolResult,
  mcpRequest,
  ORIGIN,
  rpc,
  seededDeps,
  SERVER_INFO_META,
  type RpcBody
} from '#testing/mcp/testKit.js';

import { handleMcpRequest } from './mcp.js';
import { protectedResourceMetadata } from './mcp/auth.js';
import { callHelp } from './mcp/guide.js';
import { MAX_BODY_BYTES } from './requestBody.js';

// The result shapes below are asserted field by field against the MCP schema,
// https://modelcontextprotocol.io/specification/2026-07-28/schema. The fixtures, test operations
// included, are `./mcp/testKit.js`.
const MAX_INSTRUCTIONS_LENGTH = 512;

describe('handleMcpRequest, 2026-07-28', () => {
  it('answers server/discover with a DiscoverResult', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(1, 'server/discover')
    );
    expect(body.result).toEqual({
      resultType: 'complete',
      supportedVersions: [CURRENT],
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false }
      },
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
    // 2026-07-28 takes any output schema root, so a tool answering with a list has one too.
    expect(tools.find(tool => tool.name === 'test.names')).toMatchObject({
      outputSchema: { type: 'array' }
    });
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
    // Refused by the SDK against the tool's input schema, the operation's own, in its words.
    expect(body.result).toMatchObject({
      resultType: 'complete',
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('Input validation error') as string
        }
      ]
    });
  });

  it('lists every issue of invalid arguments in the SDK refusal', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(3, 'tools/call', {
        name: 'trunks.setOrder',
        arguments: { trunkIds: [0, 0, 0] }
      })
    );
    const text = (body.result?.content as { text: string }[])[0]?.text;
    expect(text).toMatch(/^Input validation error: /u);
    expect(text).toContain('trunkIds.0: ');
    expect(text).toContain('trunkIds.2: ');
    expect(text).not.toContain('left out');
  });

  it('keeps the SDK refusal within the body limit, counting the issues it leaves out', async () => {
    const issueCount = 170_000;
    const response = await handleMcpRequest(
      await seededDeps(),
      currentRequest(3, 'tools/call', {
        name: 'trunks.setOrder',
        arguments: { trunkIds: Array<number>(issueCount).fill(0) }
      })
    );
    const raw = await response.text();
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    const body = JSON.parse(raw) as RpcBody;
    expect(body.result).toMatchObject({ isError: true });
    const text = (body.result?.content as { text: string }[])[0]?.text ?? '';
    expect(text).toMatch(/^Input validation error: .*trunkIds\.0: /u);
    const omitted = Number(
      /(?<omitted>\d+) more issues left out$/u.exec(text)?.groups?.omitted
    );
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThan(issueCount);
    expect(text).toContain(`trunkIds.${issueCount - omitted - 1}: `);
    expect(text).not.toContain(`trunkIds.${issueCount - omitted}: `);
  });

  it("shows the SDK's own short refusal of an invalid request whole", async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(3, 'prompts/get', {
        name: 'update-stack',
        arguments: { version: 1 }
      })
    );
    expect(body.error?.message).toContain(
      'Invalid input: expected string, received number'
    );
    expect(body.error?.message).not.toContain('left out');
  });

  it.each([
    [
      'every issue of invalid prompt arguments',
      currentRequest(3, 'prompts/get', {
        name: 'update-stack',
        arguments: Object.fromEntries(
          Array.from({ length: 30_000 }, (_value, index) => [`x${index}`, 0])
        )
      })
    ],
    [
      'a protocol version the body names twice over',
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
          params: {
            _meta: {
              ...currentMeta(),
              'io.modelcontextprotocol/protocolVersion': 'x'.repeat(400_000)
            }
          }
        },
        currentHeaders('tools/list')
      )
    ]
  ])(
    "keeps the SDK's own refusal quoting %s within the body limit",
    async (_name, request) => {
      const response = await handleMcpRequest(await seededDeps(), request);
      const raw = await response.text();
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_BODY_BYTES);
      const body = JSON.parse(raw) as RpcBody;
      expect(body.id).toBe(3);
      expect(body.error?.data).toBeUndefined();
      expect(body.error?.message).toMatch(/… \d+ more characters left out/u);
    }
  );

  // An id of nearly a whole request, which the response echoes, with arguments that draw a long
  // refusal in what is left of the request: the response still fits the limit, the id whole.
  it.each([
    [
      'its own refusal of invalid prompt arguments',
      'prompts/get',
      {
        name: 'update-stack',
        arguments: Object.fromEntries(
          Array.from({ length: 1_200 }, (_value, index) => [`x${index}`, 0])
        )
      }
    ],
    [
      'a refusal of invalid tool arguments',
      'tools/call',
      {
        name: 'trunks.setOrder',
        arguments: { trunkIds: Array<number>(6_000).fill(0) }
      }
    ]
  ])(
    'keeps %s within the body limit beside a long id',
    async (_name, method, params) => {
      const short = await currentRequest(3, method, params).text();
      const id = 'i'.repeat(MAX_BODY_BYTES - Buffer.byteLength(short) - 8);
      const request = currentRequest(id, method, params);
      expect(
        Buffer.byteLength(await request.clone().text())
      ).toBeLessThanOrEqual(MAX_BODY_BYTES);
      const response = await handleMcpRequest(await seededDeps(), request);
      const raw = await response.text();
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_BODY_BYTES);
      const body = JSON.parse(raw) as RpcBody;
      expect(body.id).toBe(id);
      const text =
        body.error?.message ??
        (body.result?.content as { text: string }[])[0]?.text;
      expect(text).toMatch(/… \d+ more characters left out/u);
    }
  );

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
      message: 'Tool no.such not found'
    });
    const nameless = await rpc(deps, currentRequest(5, 'tools/call', {}));
    expect(nameless.error?.code).toBe(-32602);
  });

  it('refuses a body over 512 KiB with 413', async () => {
    const refused = await handleMcpRequest(
      await seededDeps(),
      currentRequest(7, 'tools/call', {
        name: 'contacts.create',
        arguments: { displayName: 'x'.repeat(524_288) }
      })
    );
    expect(refused.status).toBe(413);
  });

  it('answers an unexpected failure as a tool execution error, leaking nothing', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(6, 'tools/call', { name: 'test.crash', arguments: {} })
    );
    expect(body.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'internal error' }]
    });
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
    const refused = await Promise.all(
      [
        { action: 'accept', content: { confirm: false } },
        { action: 'decline' },
        { action: 'cancel' }
      ].map(answer => call({ confirm: answer }))
    );
    for (const { result } of refused) {
      expect(result).toEqual(
        currentToolResult(confirmationProblem('Delete t2?'), true)
      );
    }
  });

  it('accepts the bare and form forms of the elicitation capability, not URL mode alone', async () => {
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
    expect(await resultTypeFor({})).toEqual(['input_required', undefined]);
    expect(await resultTypeFor({ form: {} })).toEqual([
      'input_required',
      undefined
    ]);
    expect(await resultTypeFor({ url: {} })).toEqual(['complete', true]);
  });
});

describe('handleMcpRequest, 2025-era clients', () => {
  it('refuses initialize as an unsupported revision, opening no session', async () => {
    const response = await handleMcpRequest(
      await seededDeps(),
      mcpRequest({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' }
        }
      })
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as RpcBody;
    expect(body.error).toMatchObject({
      code: -32022,
      data: { supported: [CURRENT] }
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
