import process from 'node:process';

import { resolveVersion } from '@zamfono/shared';

import type { OpError } from '../ops/types.js';
import { extensionMembers } from '../problem.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from './era.js';
import type { PromptContent } from './prompts.js';

// The shape of every result the endpoint answers with, per protocol era (§10.5). The field names
// are the MCP schema's own: https://modelcontextprotocol.io/specification/2026-07-28/schema and
// https://modelcontextprotocol.io/specification/2025-11-25/schema. A 2026-07-28 result carries
// `resultType` ("complete", or "input_required" for a pending elicitation) and identifies the
// server in `_meta`; a cacheable one (discovery and every list) adds `ttlMs` and `cacheScope`. A
// legacy 2025-11-25 result has none of these: the session's `initialize` identified the server.
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const TTL_MS = 300_000;
// `private`: the lists are the same for every caller today, but the endpoint serves one tenant's
// authenticated users only, so a cache must never share them across authorization contexts.
const CACHE_SCOPE = 'private';
const CAPABILITIES = { tools: {}, prompts: {} };

type TextContent = { type: 'text'; text: string };
type Result = Record<string, unknown>;

const WEBSITE_URL = 'https://github.com/zamfono/pbx';
// The logo in `static/`, served by the stack itself and public (§10.3 "Icons"). `theme` is the
// background an icon is drawn for: the black one for a light client, the white one for a dark.
const ICONS = [
  {
    path: '/logo.svg',
    mimeType: 'image/svg+xml',
    sizes: ['any'],
    theme: 'light'
  },
  {
    path: '/logoDark.svg',
    mimeType: 'image/svg+xml',
    sizes: ['any'],
    theme: 'dark'
  },
  {
    path: '/logo.png',
    mimeType: 'image/png',
    sizes: ['192x192'],
    theme: 'light'
  },
  {
    path: '/logoDark.png',
    mimeType: 'image/png',
    sizes: ['192x192'],
    theme: 'dark'
  }
];

/**
 * The `serverInfo` (`Implementation`) both eras send (§10.5). An icon's `src` must be an absolute
 * URI, so the icons are left out while `ORIGIN` is unset, as it is outside a stack (`vite dev`).
 */
export function serverInfo(env: NodeJS.ProcessEnv): Result {
  const info: Result = {
    name: 'zamfono',
    title: 'Zamfono',
    version: resolveVersion(env).display,
    websiteUrl: WEBSITE_URL
  };
  if (!env.ORIGIN) {
    return info;
  }
  const origin = new URL(env.ORIGIN).origin;
  return {
    ...info,
    icons: ICONS.map(({ path, ...icon }) => ({
      src: `${origin}${path}`,
      ...icon
    }))
  };
}

// `version` is the stack's own (§7 "Version") and the icons follow `ORIGIN`, read once: none of
// these environment variables changes for the life of the process.
const SERVER_INFO = serverInfo(process.env);

/** A 2026-07-28 `complete` result, identifying the server as the schema says it SHOULD. */
function complete(fields: Result): Result {
  return {
    resultType: 'complete',
    ...fields,
    _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO }
  };
}

function cacheable(fields: Result): Result {
  return complete({ ...fields, ttlMs: TTL_MS, cacheScope: CACHE_SCOPE });
}

/** The legacy `initialize` result (2025-11-25 `InitializeResult`), in the negotiated version. */
export function initializeResult(
  instructions: string,
  protocolVersion: string
): Result {
  return {
    protocolVersion,
    capabilities: CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions
  };
}

/** The `server/discover` result (2026-07-28 `DiscoverResult`): both eras this server speaks. */
export function discoverResult(instructions: string): Result {
  return cacheable({
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: CAPABILITIES,
    instructions
  });
}

/** A `tools/list` or `prompts/list` result, its items under the schema's own key. */
export function listResult(
  legacy: boolean,
  key: 'tools' | 'prompts',
  items: unknown[]
): Result {
  return legacy ? { [key]: items } : cacheable({ [key]: items });
}

/** A `prompts/get` result (`GetPromptResult`): not cacheable, since it carries the caller's
 * arguments. */
export function promptResult(legacy: boolean, prompt: PromptContent): Result {
  return legacy ? { ...prompt } : complete({ ...prompt });
}

function isJsonObject(value: unknown): value is Result {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A `CallToolResult` carries the tool's value twice: as `structuredContent` for a client that
// reads it, and serialised in a text block, which the schema says a structured result SHOULD also
// carry for a client that does not. 2025-11-25 limits `structuredContent` to a JSON object, so a
// legacy session gets any other value as text only; 2026-07-28 takes any JSON value.
function callToolResult(
  legacy: boolean,
  value: unknown,
  isError: boolean
): Result {
  const structured = value ?? null;
  const content: TextContent[] = [
    { type: 'text', text: JSON.stringify(structured) }
  ];
  const fields: Result =
    legacy && !isJsonObject(structured)
      ? { content, isError }
      : { content, structuredContent: structured, isError };
  return legacy ? fields : complete(fields);
}

/** A tool call that ran: its output as the result's content. */
export function toolResult(legacy: boolean, output: unknown): Result {
  return callToolResult(legacy, output, false);
}

/**
 * A tool execution error (validation, RBAC, a business rule, a declined confirmation): per MCP it
 * is reported inside the result with `isError: true`, so the model sees the refusal and can
 * correct itself, never as a JSON-RPC error. The value is the REST problem body (§10.3) without
 * its `type`, so the MCP and REST contracts read the same.
 */
export function toolErrorResult(legacy: boolean, error: OpError): Result {
  const problem = {
    status: error.status,
    title: error.title,
    ...extensionMembers(error.detail)
  };
  return callToolResult(legacy, problem, true);
}

/** The 2026-07-28 `InputRequiredResult` asking for one elicitation, keyed as its response must be. */
export function inputRequiredResult(key: string, elicitation: Result): Result {
  return {
    resultType: 'input_required',
    inputRequests: {
      [key]: { method: 'elicitation/create', params: elicitation }
    },
    _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO }
  };
}
