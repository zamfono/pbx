import type { RouteEntry } from './restRoutes.js';

const PATH_PARAM_PATTERN = /\{(?<name>[^}]+)\}/gu;

/** The `{name}` captures of a route pattern, in order. */
export function pathParamNames(pattern: string): string[] {
  return [...pattern.matchAll(PATH_PARAM_PATTERN)].map(
    match => match.groups?.name ?? ''
  );
}

/** `route.pattern`'s own static (non-`{…}`) segments, in order. */
function staticSegments(pattern: string): string[] {
  return pattern
    .split('/')
    .filter(segment => segment && !segment.startsWith('{'));
}

/**
 * A unique `operationId` per route (OpenAPI 3.1 §4.8.10), even where several routes share one
 * registered operation — `scopeRoutes`' `ooo.list`/`hours.get`/… (one per scope area, §10.3):
 * the route's own op name, suffixed with its pattern's static segments joined by `.` only when
 * another route shares that name, which is why two routes sharing an op never share a static
 * segment sequence too.
 */
export function operationIds(allRoutes: RouteEntry[]): Map<RouteEntry, string> {
  const countByOp = new Map<string, number>();
  for (const route of allRoutes) {
    countByOp.set(route.op, (countByOp.get(route.op) ?? 0) + 1);
  }
  const ids = new Map<RouteEntry, string>();
  for (const route of allRoutes) {
    if ((countByOp.get(route.op) ?? 0) <= 1) {
      ids.set(route, route.op);
      continue;
    }
    ids.set(route, `${route.op}.${staticSegments(route.pattern).join('.')}`);
  }
  return ids;
}
