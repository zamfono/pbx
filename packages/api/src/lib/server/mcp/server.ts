import { McpServer, type ServerContext } from '@modelcontextprotocol/server';

import type { Authenticated } from '../auth/bearer.js';
import type { McpDeps } from './auth.js';
import { HELP_TOOL_NAME } from './guide.js';
import INSTRUCTIONS_RAW from './instructions.txt?raw';
import { listPrompts, promptArgsSchema, renderPrompt } from './prompts.js';
import { serverInfo } from './results.js';
import { helpCall, operationCall } from './toolCall.js';
import { listTools } from './tools.js';

// The protocol itself, JSON-RPC, Streamable HTTP, `server/discover`, the per-request `_meta` and
// header checks of 2026-07-28, and the tool and prompt lists with their argument validation, is
// `@modelcontextprotocol/server`'s; what is Zamfono's is what gets registered.
// `?raw` bundles the text into the server chunk, so it ships regardless of the deployed tree's
// layout.
const INSTRUCTIONS = INSTRUCTIONS_RAW.trim();
const LIST_TTL_MS = 300_000;
// `private`: the lists are the same for every caller today, but the endpoint serves one tenant's
// authenticated users only, so a cache must never share them across authorization contexts.
const CACHE_HINT = { ttlMs: LIST_TTL_MS, cacheScope: 'private' } as const;

/** What a handler acts with: the endpoint's dependencies and the request's user and client. */
export type McpCall = { deps: McpDeps; auth: Authenticated };

function callOf(ctx: ServerContext): McpCall {
  return ctx.http?.authInfo?.extra as McpCall;
}

/** The server instance answering one request, its tools and prompts registered afresh. */
export function mcpServer(): McpServer {
  const server = new McpServer(serverInfo(), {
    // Neither list changes while the stack runs: a new operation or recipe ships with a release.
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false }
    },
    instructions: INSTRUCTIONS,
    cacheHints: {
      'server/discover': CACHE_HINT,
      'tools/list': CACHE_HINT,
      'prompts/list': CACHE_HINT
    }
  });
  for (const { name, ...config } of listTools()) {
    server.registerTool(name, config, (args, ctx) =>
      name === HELP_TOOL_NAME
        ? helpCall(args)
        : operationCall(callOf(ctx), name, args, ctx)
    );
  }
  for (const prompt of listPrompts()) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: promptArgsSchema(prompt)
      },
      args => renderPrompt(prompt, args)
    );
  }
  return server;
}
