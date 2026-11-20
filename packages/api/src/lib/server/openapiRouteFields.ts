import type { JsonSchema } from './ops/publishedSchema.js';
import { captureField, type RouteEntry } from './restRoutes.js';

export type Parameter = {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: JsonSchema;
  /** The operation input field this path parameter fills, only when it differs from `name` (`{id}` → `userId`). */
  'x-operation-field'?: string;
};

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

/** A parameter's `description`, the one its field's schema carries, which viewers and linters
 * read from the parameter itself. */
function described(description: unknown): { description?: string } {
  return typeof description === 'string' ? { description } : {};
}

/** The input schema's own top-level fields, minus `exclude`d ones (the fields the route fills from its path), as query parameters. */
export function queryParameters(
  schema: JsonSchema,
  exclude: Set<string>
): Parameter[] {
  const properties =
    (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries(properties)
    .filter(([name]) => !exclude.has(name))
    .map(([name, propertySchema]) => ({
      name,
      in: 'query' as const,
      required: required.has(name),
      ...described(propertySchema.description),
      schema: propertySchema
    }));
}

/** The path parameter `capture` of `route`, its schema the input field it fills (`properties`). */
export function pathParameter(
  route: RouteEntry,
  capture: string,
  properties: Record<string, JsonSchema>
): Parameter {
  const fieldName = captureField(route, capture);
  const schema = properties[fieldName] ?? { type: 'string' };
  const parameter: Parameter = {
    name: capture,
    in: 'path',
    required: true,
    // A capture its field does not describe is an id: of the item under the path before it.
    ...described(
      schema.description ??
        `The id of the \`${route.pattern.slice(0, route.pattern.indexOf(`/{${capture}}`))}\` item.`
    ),
    schema
  };
  return fieldName === capture
    ? parameter
    : { ...parameter, 'x-operation-field': fieldName };
}
