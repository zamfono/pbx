import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db, type StateResponse } from '@zamfono/shared';

import { storeAudio } from './audio/store.js';
import { getCoreClient } from './coreClient.js';
import { stubCoreClient } from './coreClientStub.js';
import { buildOpenApiDocument, type OpenApiDocument } from './openapi.js';
import { registry } from './ops/registry.js';
import { handleRest, type RestDeps } from './rest.js';
import { routes } from './restRoutes.js';
import { makeTestDb, owner, seedSettings } from './testDb.js';

// The upload is the REST transport's to parse; transcoding it is `audio.create`'s own concern.
vi.mock('./audio/store.js', () => ({
  storeAudio: vi.fn(async () =>
    Promise.resolve({ id: newId(), filename: 'welcome.wav' })
  ),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

const USER_IDS = ['u0', 'u1', 'u2', 'u3'];

/** A fresh in-memory database per test, so the tests never share mutable state. */
async function testDeps(): Promise<RestDeps> {
  const db = await makeTestDb();
  return { db, requestId: 'req-1' };
}

async function seedUsers(db: Db): Promise<void> {
  await db
    .insertInto('users')
    .values(
      USER_IDS.map(id => ({
        id,
        name: id,
        email: `${id}@x.test`,
        role: 'user' as const,
        createdAt: nowIso()
      }))
    )
    .execute();
  // `makeTestDb`'s owner and every user above, each with the extension a user always has.
  await db
    .insertInto('extensions')
    .values(
      ['owner', ...USER_IDS].map((userId, index) => ({
        ext: `${100 + index}`,
        userId,
        ringGroupId: null
      }))
    )
    .execute();
}

function rest(
  deps: RestDeps,
  url: string,
  init?: RequestInit
): Promise<Response> {
  return handleRest(new Request(`http://api/api/v1${url}`, init), owner, deps);
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

const OOO_PERIOD = {
  startsAt: '2026-08-01T00:00:00Z',
  expiresAt: '2026-08-08T00:00:00Z',
  target: { kind: 'external', external: '+491234567' }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the REST route table', () => {
  it('names a registered operation on every row', () => {
    expect(routes.filter(route => !registry.has(route.op))).toEqual([]);
  });
});

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
    const response = await rest(deps, '/nope');
    expect(response.status).toBe(404);
  });

  it("hands a scope route's area and id to the operation as one scope object", async () => {
    const deps = await testDeps();
    // The operation's schema declares `scope` as a discriminated object, so a flat `scope`
    // string with a separate `scopeId` is refused by its own validation before it ever runs.
    const created = await rest(deps, '/users/owner/ooo', postJson(OOO_PERIOD));
    expect(created.status).toBe(200);
    const response = await rest(deps, '/users/owner/ooo');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { scope: unknown }[] };
    expect(body.items.map(item => item.scope)).toEqual([
      { kind: 'user', id: 'owner' }
    ]);
  });

  it('hands a tenant-scoped route the scope with no id', async () => {
    const deps = await testDeps();
    const created = await rest(deps, '/tenant/ooo', postJson(OOO_PERIOD));
    expect(created.status).toBe(200);
    const response = await rest(deps, '/tenant/ooo');
    const body = (await response.json()) as { items: { scope: unknown }[] };
    expect(body.items.map(item => item.scope)).toEqual([{ kind: 'tenant' }]);
  });

  it('answers 409 with the confirmation question when DELETE omits confirm', async () => {
    const deps = await testDeps();
    await seedUsers(deps.db);
    const response = await rest(deps, '/users/u1', { method: 'DELETE' });
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
    await seedUsers(deps.db);
    // Deleting a user re-pushes the provisioning roster, which reads the tenant settings.
    await seedSettings(deps.db);
    const response = await rest(deps, '/users/u1', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'u1' });
  });

  it('answers 409 with the blocking references for a Conflict', async () => {
    const deps = await testDeps();
    const number = '+4930123456';
    const first = await rest(deps, '/blockedNumbers', postJson({ number }));
    const { id } = (await first.json()) as { id: string };
    const response = await rest(deps, '/blockedNumbers', postJson({ number }));
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      references: { kind: string; id: string; label: string }[];
    };
    expect(body.references).toEqual([
      { kind: 'blockedNumber', id, label: number }
    ]);
  });

  it('paginates with ?limit= and continues from the returned nextCursor', async () => {
    const deps = await testDeps();
    await seedUsers(deps.db);
    const LIMIT = 2;
    const first = await rest(deps, `/users?limit=${LIMIT}`);
    const firstBody = (await first.json()) as {
      items: { id: string }[];
      nextCursor: string;
    };
    expect(firstBody.items).toHaveLength(LIMIT);
    expect(typeof firstBody.nextCursor).toBe('string');

    const second = await rest(
      deps,
      `/users?limit=${LIMIT}&cursor=${encodeURIComponent(firstBody.nextCursor)}`
    );
    const secondBody = (await second.json()) as { items: { id: string }[] };
    expect(secondBody.items).toHaveLength(LIMIT);
    const seen = [...firstBody.items, ...secondBody.items].map(item => item.id);
    expect(new Set(seen).size).toBe(LIMIT * 2);
  });

  it('does not coerce a digits-only string filter into a number', async () => {
    const deps = await testDeps();
    await seedSettings(deps.db);
    // `search.query`'s `q` is a string; a number would fail its validation with a 422.
    const response = await rest(deps, '/search?q=101');
    expect(response.status).toBe(200);
  });

  it('coerces a boolean query field the operation schema declares', async () => {
    const deps = await testDeps();
    const state = vi.fn(() =>
      Promise.resolve({ calls: [] } as unknown as StateResponse)
    );
    vi.mocked(getCoreClient).mockReturnValue(stubCoreClient({ state }));
    const response = await rest(deps, '/calls?live=true');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(state).toHaveBeenCalledOnce();
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
    const response = await rest(deps, '/audio', { method: 'POST', body: form });
    expect(response.status).toBe(200);
    expect(vi.mocked(storeAudio)).toHaveBeenCalledWith('greeting', {
      filename: 'welcome.wav',
      mimeType: 'audio/wav',
      data: Buffer.from('audio-bytes')
    });
    expect(await response.json()).toMatchObject({ label: 'Welcome' });
  });

  it('answers audio bytes directly instead of JSON-wrapping a Buffer', async () => {
    const deps = await testDeps();
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-rest-'));
    await mkdir(path.join(mediaDir, 'voicemail'));
    await writeFile(
      path.join(mediaDir, 'voicemail', 'vm1.wav'),
      'audio-for-vm1'
    );
    vi.stubEnv('MEDIA_DIR', mediaDir);
    await deps.db
      .insertInto('voicemails')
      .values({
        id: 'vm1',
        mailboxUserId: 'owner',
        caller: '+491234',
        filename: 'vm1.wav',
        durationS: 10,
        read: 0,
        createdAt: nowIso()
      })
      .execute();
    const response = await rest(deps, '/voicemails/vm1/audio');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString()).toBe('audio-for-vm1');
  });
});

/** `doc.paths[pattern][method]`, every route table entry this describe block asserts on. */
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
  it("lists every route of the table, with its operation's zod-derived schema", () => {
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
    expect(limitParam?.schema.type).toBe('integer');
    // `{id}` is the URL's (§10.3); the body carries the confirmation instead.
    const usersDelete = operationAt(doc, '/users/{id}', 'delete');
    const deleteBody =
      usersDelete.requestBody?.content['application/json']?.schema.properties;
    expect(deleteBody).toHaveProperty('confirm');
    expect(deleteBody).not.toHaveProperty('id');
  });

  it('does not throw building the document once an area with an unrepresentable input type (a Buffer) is registered', () => {
    // `audio.create` carries `z.instanceof(Buffer)`; without
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

  it("excludes a scope route's own `scope` field from its query parameters and request body", () => {
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
