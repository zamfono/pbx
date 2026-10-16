import type {
  CallToolResult,
  Icon,
  Implementation
} from '@modelcontextprotocol/server';
import * as privateEnv from '$app/env/private';

import { resolveVersion } from '@zamfono/shared';

import type { OpError } from '../ops/types.js';
import { extensionMembers } from '../problem.js';
import { originFromEnv } from '../stackAddress.js';

// What Zamfono puts into the results the SDK frames (§10.5): the server's identity and a tool
// call's value. Each era's own fields (`resultType`, `ttlMs`, `cacheScope`, the `serverInfo` in
// `_meta`) are the SDK's.
const WEBSITE_URL = 'https://github.com/zamfono/pbx';
// The logo in `static/`, served by the stack itself and public (§10.3 "Icons"). `theme` is the
// background an icon is drawn for: the black one for a light client, the white one for a dark.
const ICONS: (Omit<Icon, 'src'> & { path: string })[] = [
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
 * The `serverInfo` (`Implementation`) both eras send (§10.5); an icon's `src` is an absolute URI
 * on the stack's own origin.
 */
export function serverInfo(): Implementation {
  const origin = originFromEnv();
  return {
    name: 'zamfono',
    title: 'Zamfono',
    version: resolveVersion(privateEnv).display,
    websiteUrl: WEBSITE_URL,
    icons: ICONS.map(({ path, ...icon }) => ({
      src: `${origin}${path}`,
      ...icon
    }))
  };
}

// A `CallToolResult` carries the tool's value twice: as `structuredContent` for a client that
// reads it, and serialised in a text block, which the schema says a structured result SHOULD also
// carry for a client that does not; 2026-07-28 takes any JSON value as `structuredContent`.
function callToolResult(value: unknown, isError: boolean): CallToolResult {
  const structured = (value ?? null) as CallToolResult['structuredContent'];
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError
  };
}

/** A tool call that ran: its output as the result's content. */
export function toolResult(output: unknown): CallToolResult {
  return callToolResult(output, false);
}

/**
 * A tool execution error (validation, RBAC, a business rule, a declined confirmation): per MCP it
 * is reported inside the result with `isError: true`, so the model sees the refusal and can
 * correct itself, never as a JSON-RPC error. The value is the REST problem body (§10.3) without
 * its `type`, so the MCP and REST contracts read the same.
 */
export function toolErrorResult(error: OpError): CallToolResult {
  const problem = {
    status: error.status,
    title: error.title,
    ...extensionMembers(error.detail)
  };
  return callToolResult(problem, true);
}
