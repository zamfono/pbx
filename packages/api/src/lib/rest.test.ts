import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildOpenApiDocument, type OpenApiDocument } from './openapi.js';
import { register } from './ops/registry.js';
import { Conflict, defineOperation, type Actor } from './ops/types.js';
import { decodeCursor, encodeCursor } from './pagination.js';
import { handleRest, type RestDeps } from './rest.js';
import { routes } from './restRoutes.js';
import { makeTestDb } from './testDb.js';

const PAGE_ITEM_COUNT = 5;
const ITEMS = Array.from({ length: PAGE_ITEM_COUNT }, (_unused, index) => ({
  id: `user-${index}`
}));

// Stubs standing in for the not-yet-built `users.list`/`users.delete` and `trunks.delete`
// (Tasks 20-21): this task tests the REST catch-all's own plumbing — pagination, confirmation,
// error shapes — against real route-table entries, without depending on those tasks.
register(
  defineOperation({
    name: 'users.list',
    description: 'Lists tenant users, paginated.',
    input: z.object({
      limit: z.number().optional(),
      cursor: z.string().optional()
    }),
    minRole: 'admin',
    readOnly: true,
    run: (_ctx, input) => {
      const offset =
        input.cursor === undefined
          ? 0
          : (decodeCursor(input.cursor) as { offset: number }).offset;
      const limit = input.limit ?? ITEMS.length;
      const page = ITEMS.slice(offset, offset + limit);
      const nextOffset = offset + limit;
      const nextCursor =
        nextOffset < ITEMS.length ? encodeCursor({ offset: nextOffset }) : null;
      return Promise.resolve({ items: page, nextCursor });
    }
  })
);

register(
  defineOperation({
    name: 'users.delete',
    description: 'Deletes a user.',
    input: z.object({ id: z.string() }),
    minRole: 'admin',
    confirm: input => `Delete user ${input.id}?`,
    entity: input => ({ kind: 'user', id: input.id }),
    run: () => Promise.resolve({ ok: true })
  })
);

register(
  defineOperation({
    name: 'trunks.delete',
    description: 'Deletes a trunk.',
    input: z.object({ id: z.string() }),
    minRole: 'admin',
    confirm: input => `Delete trunk ${input.id}?`,
    entity: input => ({ kind: 'trunk', id: input.id }),
    run: () =>
      Promise.reject(
        new Conflict('trunk is in use', [
          { kind: 'outboundRoute', id: 'route-1', label: 'Main route' }
        ])
      )
  })
);

// Mirrors ops/search/query.ts's own schema, so `q` (a digits-only string is a legal search term)
// is never guessed into a number by the transport (§10.3, `GET /search?q=`).
register(
  defineOperation({
    name: 'search.query',
    description: 'The type-ahead behind the search bar.',
    // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3
    input: z.object({ q: z.string().min(1) }).strict(),
    minRole: 'user',
    readOnly: true,
    run: (_ctx, input) =>
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3
      Promise.resolve({ items: [], q: input.q })
  })
);

register(
  defineOperation({
    name: 'calls.list',
    description: 'Lists call history.',
    input: z
      .object({
        live: z.boolean().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional()
      })
      .strict(),
    minRole: 'user',
    readOnly: true,
    run: (_ctx, input) =>
      Promise.resolve({ items: [], live: input.live ?? false })
  })
);

// Mirrors `ops/ooo`'s own scope shape: a scope route's path carries the area and the id, and the
// operation takes them as the one discriminated object its schema declares (§10.3).
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tenant') }),
  z.object({ kind: z.literal('user'), id: z.string() }),
  z.object({ kind: z.literal('ringGroup'), id: z.string() }),
  z.object({ kind: z.literal('menu'), id: z.string() })
]);
register(
  defineOperation({
    name: 'ooo.list',
    description: 'Lists out-of-office periods for a scope.',
    input: z.object({ scope: scopeSchema }).strict(),
    minRole: 'admin',
    readOnly: true,
    run: (_ctx, input) =>
      Promise.resolve({ items: [input.scope], nextCursor: null })
  })
);
register(
  defineOperation({
    name: 'ooo.create',
    description: 'Creates an out-of-office period for a scope.',
    input: z
      .object({ scope: scopeSchema, from: z.string(), to: z.string() })
      .strict(),
    minRole: 'admin',
    entity: () => ({ kind: 'ooo', id: null }),
    run: () => Promise.resolve({ id: 'ooo-1' })
  })
);

// Mirrors ops/audio/create.ts's own schema: a `multipart: true` route's file field must reach the
// operation as `{ filename, mimeType, data }`, the shape `upload` requires (§10.3 "Audio").
register(
  defineOperation({
    name: 'audio.create',
    description: 'Uploads a new audio asset.',
    input: z
      .object({
        kind: z.enum(['greeting', 'moh', 'vmGreeting', 'announcement']),
        label: z.string().min(1),
        upload: z.object({
          filename: z.string().min(1),
          mimeType: z.string().min(1),
          data: z.instanceof(Buffer)
        })
      })
      .strict(),
    minRole: 'admin',
    entity: (_input, out: { id: string }) => ({ kind: 'audio', id: out.id }),
    run: (_ctx, input) =>
      Promise.resolve({ id: 'audio-1', filename: input.upload.filename })
  })
);

register(
  defineOperation({
    name: 'voicemails.audio',
    description: "Returns a voicemail's recorded audio.",
    input: z.object({ id: z.string() }).strict(),
    minRole: 'user',
    readOnly: true,
    run: (_ctx, input) =>
      Promise.resolve({
        bytes: Buffer.from(`audio-for-${input.id}`),
        contentType: 'audio/mpeg',
        filename: `${input.id}.mp3`
      })
  })
);

const admin: Actor = { id: 'admin1', name: 'Admin', role: 'admin' };

/** A fresh in-memory database per test, so the tests never share mutable state. */
async function testDeps(): Promise<RestDeps> {
  const db = await makeTestDb();
  return { db, requestId: 'req-1' };
}

describe('handleRest', () => {
  it('answers 401 problem+json for a request without a bearer token', async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/users'),
      null,
      deps
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json'
    );
    const body = (await response.json()) as { status: number };
    expect(body.status).toBe(401);
  });

  it('answers 404 for a path matching no route', async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/nope'),
      admin,
      deps
    );
    expect(response.status).toBe(404);
  });

  it("hands a scope route's area and id to the operation as one scope object", async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/ringGroups/rg-1/ooo'),
      admin,
      deps
    );
    expect(response.status).toBe(200);
    // The operation's schema declares `scope` as a discriminated object, so a flat `scope`
    // string with a separate `scopeId` is refused by its own validation before it ever runs.
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items[0]).toEqual({ kind: 'ringGroup', id: 'rg-1' });
  });

  it('hands a tenant-scoped route the scope with no id', async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/tenant/ooo'),
      admin,
      deps
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items[0]).toEqual({ kind: 'tenant' });
  });

  it('answers 501 for a route whose operation is not registered yet', async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/ringGroups'),
      admin,
      deps
    );
    expect(response.status).toBe(501);
  });

  it('answers 409 with the confirmation question when DELETE omits confirm', async () => {
    const deps = await testDeps();
    const request = new Request('http://api/api/v1/users/u1', {
      method: 'DELETE'
    });
    const response = await handleRest(request, admin, deps);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      confirmationRequired: boolean;
      question: string;
    };
    expect(body.confirmationRequired).toBe(true);
    expect(typeof body.question).toBe('string');
  });

  it('runs the operation once the body carries confirm: true', async () => {
    const deps = await testDeps();
    const request = new Request('http://api/api/v1/users/u1', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true })
    });
    const response = await handleRest(request, admin, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers 409 with the blocking references for a Conflict', async () => {
    const deps = await testDeps();
    const request = new Request('http://api/api/v1/trunks/t1', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true })
    });
    const response = await handleRest(request, admin, deps);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      references: { kind: string; id: string; label: string }[];
    };
    expect(body.references).toEqual([
      { kind: 'outboundRoute', id: 'route-1', label: 'Main route' }
    ]);
  });

  it('paginates with ?limit= and continues from the returned nextCursor', async () => {
    const deps = await testDeps();
    const LIMIT = 2;
    const first = await handleRest(
      new Request(`http://api/api/v1/users?limit=${LIMIT}`),
      admin,
      deps
    );
    const firstBody = (await first.json()) as {
      items: unknown[];
      nextCursor: string;
    };
    expect(firstBody.items).toEqual(ITEMS.slice(0, LIMIT));
    expect(typeof firstBody.nextCursor).toBe('string');

    const second = await handleRest(
      new Request(
        `http://api/api/v1/users?limit=${LIMIT}&cursor=${encodeURIComponent(firstBody.nextCursor)}`
      ),
      admin,
      deps
    );
    const secondBody = (await second.json()) as { items: unknown[] };
    expect(secondBody.items).toEqual(ITEMS.slice(LIMIT, LIMIT * 2));
  });

  it('does not coerce a digits-only string filter into a number', async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/search?q=101'),
      admin,
      deps
    );
    expect(response.status).toBe(200);
    // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3
    expect(await response.json()).toEqual({ items: [], q: '101' });
  });

  it('coerces a boolean query field the operation schema declares', async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/calls?live=true'),
      admin,
      deps
    );
    expect(await response.json()).toEqual({ items: [], live: true });
  });

  it('parses a multipart upload into the operation contract', async () => {
    const deps = await testDeps();
    const form = new FormData();
    form.set('kind', 'greeting');
    form.set('label', 'Welcome');
    form.set(
      'upload',
      new File([Buffer.from('audio-bytes')], 'welcome.wav', {
        type: 'audio/wav'
      })
    );
    const response = await handleRest(
      new Request('http://api/api/v1/audio', { method: 'POST', body: form }),
      admin,
      deps
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'audio-1',
      filename: 'welcome.wav'
    });
  });

  it('answers audio bytes directly instead of JSON-wrapping a Buffer', async () => {
    const deps = await testDeps();
    const response = await handleRest(
      new Request('http://api/api/v1/voicemails/vm1/audio'),
      admin,
      deps
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString()).toBe('audio-for-vm1');
  });
});

/** `doc.paths[pattern][method]`, every route table entry this describe block asserts on
 * (registered by the routes above or `ops/index.js`). */
function operationAt(
  doc: OpenApiDocument,
  pattern: string,
  method: string
): OpenApiDocument['paths'][string][string] {
  const operation = doc.paths[pattern]?.[method];
  if (operation === undefined) {
    throw new Error(`openapi test: no operation for ${method} ${pattern}`);
  }
  return operation;
}

describe('buildOpenApiDocument', () => {
  it('lists every route of the table, with a zod-derived schema where the operation is registered', () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    for (const route of routes) {
      const entry = operationAt(doc, route.pattern, route.method.toLowerCase());
      // `operationId` disambiguates routes that share one registered operation (`ooo.*`,
      // `hours.*`); `x-operation-name` always names the operation itself.
      expect(entry['x-operation-name']).toBe(route.op);
    }
    const usersList = operationAt(doc, '/users', 'get');
    const limitParam = usersList.parameters?.find(
      parameter => parameter.name === 'limit'
    );
    expect(limitParam?.schema.type).toBe('number');
    // `{id}` is the URL's (§10.3); the body carries the confirmation instead.
    const usersDelete = operationAt(doc, '/users/{id}', 'delete');
    const deleteBody =
      usersDelete.requestBody?.content['application/json']?.schema.properties;
    expect(deleteBody).toHaveProperty('confirm');
    expect(deleteBody).not.toHaveProperty('id');
  });

  it('does not throw building the document once an area with an unrepresentable input type (a Buffer) is registered', () => {
    // `audio.create` (registered above) carries `z.instanceof(Buffer)`; without
    // `unrepresentable: 'any'`, z.toJSONSchema throws for it.
    expect(() => buildOpenApiDocument()).not.toThrow();
    const doc = buildOpenApiDocument();
    expect(
      operationAt(doc, '/audio', 'post').requestBody?.content[
        'multipart/form-data'
      ]
    ).toBeDefined();
  });

  it('gives every route a unique operationId', () => {
    const doc = buildOpenApiDocument();
    const ids = Object.values(doc.paths).flatMap(methods =>
      Object.values(methods).map(operation => operation.operationId)
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every path parameter after its own template expression (OpenAPI 3.1 §4.8.12.1)', () => {
    const doc = buildOpenApiDocument();
    for (const route of routes) {
      const templateNames = [
        ...route.pattern.matchAll(/\{(?<name>[^}]+)\}/gu)
      ].map(match => match.groups?.name ?? '');
      const operation = operationAt(
        doc,
        route.pattern,
        route.method.toLowerCase()
      );
      const pathParamNames = (operation.parameters ?? [])
        .filter(parameter => parameter.in === 'path')
        .map(parameter => parameter.name);
      expect(new Set(pathParamNames)).toEqual(new Set(templateNames));
    }
  });

  it('records the operation field a renamed path parameter fills, as x-operation-field', () => {
    const doc = buildOpenApiDocument();
    // `/users/{id}/devices` maps its `{id}` capture to the operation's own `userId` field
    // (`WITH_USER_ID`); the parameter is still named `id` (the template expression), with
    // `userId` carried alongside it.
    const devicesList = operationAt(doc, '/users/{id}/devices', 'get');
    const idParam = devicesList.parameters?.find(
      parameter => parameter.name === 'id'
    );
    expect(idParam?.['x-operation-field']).toBe('userId');
  });

  it('routes GET /menus/{id}/targets to menus.getTargets, the shape PUT takes', () => {
    const doc = buildOpenApiDocument();
    expect(
      operationAt(doc, '/menus/{id}/targets', 'get')['x-operation-name']
    ).toBe('menus.getTargets');
  });

  it("excludes a scope route's own constant field from its query parameters and request body", () => {
    const doc = buildOpenApiDocument();
    const oooList = operationAt(doc, '/users/{id}/ooo', 'get');
    expect(
      oooList.parameters?.some(parameter => parameter.name === 'scope')
    ).toBe(false);
    const oooCreate = operationAt(doc, '/users/{id}/ooo', 'post');
    expect(
      oooCreate.requestBody?.content['application/json']?.schema.properties
    ).not.toHaveProperty('scope');
  });

  it('declares the API base path as a server entry', () => {
    const doc = buildOpenApiDocument();
    expect(doc.servers).toEqual([{ url: '/api/v1' }]);
  });

  it('declares a bearer JWT security scheme, required document-wide', () => {
    const doc = buildOpenApiDocument();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer'
    });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it('validates against the OpenAPI 3.1 meta-schema', async () => {
    const doc = buildOpenApiDocument();
    await expect(
      SwaggerParser.validate(structuredClone(doc) as never)
    ).resolves.toBeTruthy();
  });

  it('fails that same validation for a document missing a required field', async () => {
    const broken = structuredClone(buildOpenApiDocument()) as Record<
      string,
      unknown
    >;
    delete (broken.info as Record<string, unknown>).version;
    await expect(SwaggerParser.validate(broken as never)).rejects.toThrow();
  });

  it('produces a document whose fragments are well-formed JSON Schema', () => {
    const doc = buildOpenApiDocument();
    expect(typeof doc.info.title).toBe('string');
    expect(typeof doc.info.version).toBe('string');
    for (const methods of Object.values(doc.paths)) {
      for (const operation of Object.values(methods)) {
        for (const response of Object.values(operation.responses)) {
          expect(typeof response.description).toBe('string');
        }
        for (const schema of [
          ...(operation.parameters?.map(parameter => parameter.schema) ?? []),
          ...Object.values(operation.requestBody?.content ?? {}).map(
            entry => entry.schema
          )
        ]) {
          if ('$ref' in schema) {
            expect(typeof schema.$ref).toBe('string');
          } else if ('type' in schema) {
            expect(
              typeof schema.type === 'string' || Array.isArray(schema.type)
            ).toBe(true);
          }
        }
      }
    }
  });
});
