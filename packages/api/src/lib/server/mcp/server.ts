import {
  McpServer,
  type ServerContext,
  type StandardSchemaV1
} from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { Authenticated } from '../auth/bearer.js';
import { boundedIssues } from '../problem.js';
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

/** A failed validation's issues bounded as a problem's `errors` are, the rest counted in one more. */
function boundResult<T>(
  result: StandardSchemaV1.Result<T>
): StandardSchemaV1.Result<T> {
  if (!result.issues) {
    return result;
  }
  const { kept, omitted } = boundedIssues(result.issues);
  return omitted > 0
    ? { issues: [...kept, { message: `${omitted} more issues left out` }] }
    : result;
}

/**
 * `schema` with a bounded Standard Schema validation: the SDK validates a call's arguments with it
 * before the tool runs and refuses an invalid one with `Input validation error: …` listing every
 * issue it returns (§10.5), so its refusal stays as small as a REST problem's (§10.3).
 */
function boundedValidation(schema: z.ZodObject): z.ZodObject {
  const bounded = schema.clone();
  const standard = schema['~standard'];
  bounded['~standard'] = {
    ...standard,
    validate: (value, options) => {
      const result = standard.validate(value, options);
      return result instanceof Promise
        ? result.then(boundResult)
        : boundResult(result);
    }
  };
  return bounded;
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
  for (const { name, inputSchema, ...config } of listTools()) {
    const definition = {
      ...config,
      inputSchema: boundedValidation(inputSchema)
    };
    server.registerTool(name, definition, (args, ctx) =>
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
