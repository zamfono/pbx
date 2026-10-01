import type { Db } from '@zamfono/shared';

import { registry } from './ops/registry.js';
import { runOperation } from './ops/runner.js';
import { type Actor } from './ops/types.js';
import { problem, problemFromError } from './problem.js';
import { readBody } from './restBody.js';
import { defaultParams, routes, type RouteEntry } from './restRoutes.js';
import { outputResponse } from './restTransport.js';

export type RestDeps = {
  db: Db;
  requestId: string;
  clientId?: string | null;
  clientName?: string;
};

/** A `{name}` path segment becomes a named regex capture, so its value comes back as `match.groups.name`. */
function compilePattern(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map(segment =>
      segment.startsWith('{') && segment.endsWith('}')
        ? `(?<${segment.slice(1, -1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    )
    .join('/');
  return new RegExp(`^${source}$`, 'u');
}

type Matched = { route: RouteEntry; match: RegExpMatchArray };

const compiled = routes.map(route => ({
  route,
  regex: compilePattern(route.pattern)
}));

function matchRoute(method: string, path: string): Matched | null {
  for (const { route, regex } of compiled) {
    if (route.method !== method) {
      continue;
    }
    const match = path.match(regex);
    if (match) {
      return { route, match };
    }
  }
  return null;
}

const UNAUTHORIZED_STATUS = 401;
const NOT_FOUND_STATUS = 404;
const NOT_IMPLEMENTED_STATUS = 501;
const API_PREFIX = '/api/v1';

function requestPath(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.startsWith(API_PREFIX)
    ? pathname.slice(API_PREFIX.length) || '/'
    : pathname;
}

/**
 * The REST catch-all (§10.3): matches `request` against the route table, checks the operation is
 * registered, builds its input from the path, query or body, and runs it. `actor` is `null` for a
 * missing or invalid bearer token; every other REST convention (confirmation, RBAC, validation)
 * is the runner's.
 */
export async function handleRest(
  request: Request,
  actor: Actor | null,
  deps: RestDeps
): Promise<Response> {
  if (!actor) {
    return problem(UNAUTHORIZED_STATUS, 'unauthorized');
  }
  const matched = matchRoute(request.method, requestPath(request));
  if (!matched) {
    return problem(NOT_FOUND_STATUS, 'no such endpoint');
  }
  const { route, match } = matched;
  const op = registry.get(route.op);
  if (!op) {
    return problem(NOT_IMPLEMENTED_STATUS, 'operation not yet available');
  }
  try {
    const { confirm, ...fields } = await readBody(request, route, op.input);
    const input = { ...fields, ...(route.params ?? defaultParams)(match) };
    const output = await runOperation(deps.db, route.op, input, {
      actor,
      channel: 'rest',
      clientId: deps.clientId ?? undefined,
      clientName: deps.clientName,
      requestId: deps.requestId,
      confirm: confirm === true
    });
    return outputResponse(output);
  } catch (error) {
    return problemFromError(error);
  }
}
