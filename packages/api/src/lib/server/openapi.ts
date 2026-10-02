import { operationIds, pathParamNames } from './openapiRouteFields.js';
import {
  inputJsonSchema,
  publishedInputSchema,
  type JsonSchema
} from './ops/publishedSchema.js';
import {
  captureField,
  routeOperation,
  routes,
  type RouteEntry
} from './restRoutes.js';

type Parameter = {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
  /** The operation input field this path parameter fills, only when it differs from `name` (`{id}` → `userId`). */
  'x-operation-field'?: string;
};

type OpenApiOperation = {
  operationId: string;
  summary: string;
  /** The operation's registry name (§10.3); distinct routes can share one when `operationId` had to be disambiguated. */
  'x-operation-name': string;
  parameters?: Parameter[];
  requestBody?: { content: Record<string, { schema: JsonSchema }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
};

export type OpenApiDocument = {
  openapi: '3.1.0';
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, JsonSchema>;
  };
  security: Record<string, never[]>[];
};

const OPENAPI_VERSION = '3.1.0';
const API_VERSION = 'v1';
const API_BASE_PATH = '/api/v1';
const JSON_CONTENT_TYPE = 'application/json';
const MULTIPART_CONTENT_TYPE = 'multipart/form-data';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const PROBLEM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' }
  },
  required: ['title', 'status']
};

// Every operation can answer any of these through the runner (§10.3 "Confirmation", RBAC, input
// validation), regardless of its own success shape.
const PROBLEM_STATUSES = ['401', '403', '404', '409', '422'];

const BEARER_SECURITY_SCHEME: JsonSchema = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT'
};

const OPERATION_IDS = operationIds(routes);

function problemResponse(): {
  description: string;
  content: Record<string, { schema: JsonSchema }>;
} {
  return {
    description: 'RFC 9457 problem details',
    content: {
      [PROBLEM_CONTENT_TYPE]: {
        schema: { $ref: '#/components/schemas/Problem' }
      }
    }
  };
}

/** The input schema's own top-level fields, minus `exclude`d ones (the fields the route fills from its path), as query parameters. */
function queryParameters(
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
      schema: propertySchema
    }));
}

function responses(): OpenApiOperation['responses'] {
  const entries = PROBLEM_STATUSES.map(
    status => [status, problemResponse()] as const
  );
  return {
    '200': {
      description: 'Successful response',
      content: { [JSON_CONTENT_TYPE]: { schema: {} } }
    },
    ...Object.fromEntries(entries)
  };
}

function operationFor(route: RouteEntry): OpenApiOperation {
  const op = routeOperation(route);
  const captures = pathParamNames(route.pattern);
  // The fields the route fills from its path, never the client's: its captures', and a scope
  // route's `scope` (`pathInput`).
  const routeFields = new Set(
    captures.map(capture => captureField(route, capture))
  );
  if (route.scope !== undefined) {
    routeFields.add('scope');
  }
  const inputSchema = inputJsonSchema(op);
  const properties =
    (inputSchema.properties as Record<string, JsonSchema> | undefined) ?? {};
  // OpenAPI 3.1 §4.8.12.1 / Path Templating: a path parameter's `name` is the template expression
  // itself (`{id}` → `id`), regardless of the operation field it fills; `x-operation-field` carries
  // that field name where it differs (`{id}` → `userId` on `/users/{id}/devices`).
  const parameters: Parameter[] = captures.map(capture => {
    const fieldName = captureField(route, capture);
    const parameter: Parameter = {
      name: capture,
      in: 'path',
      required: true,
      schema: properties[fieldName] ?? { type: 'string' }
    };
    return fieldName === capture
      ? parameter
      : { ...parameter, 'x-operation-field': fieldName };
  });
  const base: OpenApiOperation = {
    operationId: OPERATION_IDS.get(route) ?? route.op,
    summary: op.description,
    'x-operation-name': route.op,
    parameters,
    responses: responses()
  };
  if (route.method === 'GET') {
    return {
      ...base,
      parameters: [...parameters, ...queryParameters(inputSchema, routeFields)]
    };
  }
  const contentType = route.multipart
    ? MULTIPART_CONTENT_TYPE
    : JSON_CONTENT_TYPE;
  // The route fills its own fields after the body is read (`handleRest`), so they are the URL's,
  // never the body's; `confirm` rides in the body (§10.3 "Confirmation").
  const bodySchema = publishedInputSchema(op, routeFields);
  return {
    ...base,
    requestBody: { content: { [contentType]: { schema: bodySchema } } }
  };
}

/**
 * The OpenAPI 3.1 document served at `/api/v1/openapi.json` (§10.3): every route of the table
 * appears, with its operation's zod-derived JSON Schema.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  for (const route of routes) {
    let methods = paths[route.pattern];
    if (methods === undefined) {
      methods = {};
      paths[route.pattern] = methods;
    }
    methods[route.method.toLowerCase()] = operationFor(route);
  }
  return {
    openapi: OPENAPI_VERSION,
    info: { title: 'Zamfono API', version: API_VERSION },
    servers: [{ url: API_BASE_PATH }],
    paths,
    components: {
      schemas: { Problem: PROBLEM_SCHEMA },
      securitySchemes: { bearerAuth: BEARER_SECURITY_SCHEME }
    },
    security: [{ bearerAuth: [] }]
  };
}
