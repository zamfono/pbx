import { defaultParams, type RouteEntry } from './restRoutes.js';

const PATH_PARAM_PATTERN = /\{(?<name>[^}]+)\}/gu;

/** The `{name}` captures of a route pattern, in order. */
export function pathParamNames(pattern: string): string[] {
  return [...pattern.matchAll(PATH_PARAM_PATTERN)].map(
    match => match.groups?.name ?? ''
  );
}

export type RouteFieldMapping = {
  /** Capture name → the operation field it fills; identity unless `route.params` renames it. */
  byCapture: Map<string, string>;
  /** Fields the route's own `params` supplies that fill no capture (`scopeRoutes`' constant `scope`). */
  constants: Set<string>;
};

/**
 * Resolves the route's own `params` (or the identity default) against a synthetic match whose
 * capture values equal their own names, so whichever output field comes back holding a capture's
 * name is that capture's field (`withUserId`'s `{ userId: match.groups.id }` resolves capture `id`
 * to field `userId`). Every other field the route supplies — one with no matching capture, such as
 * `scopeRoutes`' constant `scope` — is a `constant`: the client's own value for it is discarded
 * (`handleRest` applies `route.params` after the request body), so it is documented nowhere.
 */
export function routeFieldMapping(route: RouteEntry): RouteFieldMapping {
  const captures = pathParamNames(route.pattern);
  const identityMatch = {
    groups: Object.fromEntries(captures.map(name => [name, name]))
  } as unknown as RegExpMatchArray;
  const output = (route.params ?? defaultParams)(identityMatch);
  const byCapture = new Map<string, string>();
  for (const capture of captures) {
    const fieldName = Object.entries(output).find(
      ([, value]) => value === capture
    )?.[0];
    byCapture.set(capture, fieldName ?? capture);
  }
  const pathFields = new Set(byCapture.values());
  const constants = new Set(
    Object.keys(output).filter(key => !pathFields.has(key))
  );
  return { byCapture, constants };
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
