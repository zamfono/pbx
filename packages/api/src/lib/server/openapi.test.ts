import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildOpenApiDocument } from './openapi.js';
// The real registry, as `/api/v1/openapi.json` serves it.
import './ops/index.js';

type Schema = Record<string, unknown> & {
  properties?: Record<string, unknown>;
  required?: string[];
};

function bodySchema(pattern: string, method: string): Schema {
  const operation = buildOpenApiDocument().paths[pattern]?.[method];
  if (operation === undefined) {
    throw new Error(`openapi test: no operation for ${method} ${pattern}`);
  }
  const schema = operation.requestBody?.content['application/json']?.schema;
  expect(schema).toBeDefined();
  return schema as Schema;
}

/** `schema` as a validator, the way a client generated from the document would check a body. */
function accepts(schema: Schema, body: unknown): boolean {
  return z
    .fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
    .safeParse(body).success;
}

describe('the OpenAPI request bodies describe the REST contract (§10.3)', () => {
  it.each([
    ['/users/{id}', 'delete'],
    ['/users/{id}/erase', 'post'],
    ['/devices/{id}/rotate', 'post']
  ])(
    '%s %s documents `confirm` and leaves the path parameter to the URL',
    (pattern, method) => {
      const schema = bodySchema(pattern, method);
      expect(schema.properties).toHaveProperty('confirm', {
        type: 'boolean',
        description: expect.stringContaining('409') as unknown
      });
      expect(schema.properties).not.toHaveProperty('id');
      expect(schema.required ?? []).not.toContain('id');
      // The first, unconfirmed call is what earns the question, so `confirm` is not required.
      expect(schema.required ?? []).not.toContain('confirm');
      expect(accepts(schema, { confirm: true })).toBe(true);
      expect(accepts(schema, {})).toBe(true);
    }
  );

  it('keeps a plain write free of `confirm` and still forbids a strict schema’s unknown keys', () => {
    const presence = bodySchema('/users/{id}/presence', 'put');
    expect(presence.properties).toEqual({
      dnd: {
        type: 'boolean',
        description: expect.stringContaining('Do not disturb') as unknown
      }
    });
    expect(presence.required).toEqual(['dnd']);
    expect(accepts(presence, { dnd: true })).toBe(true);
    expect(accepts(presence, { dnd: true, colour: 'red' })).toBe(false);

    const usersCreate = bodySchema('/users', 'post');
    expect(usersCreate.properties).not.toHaveProperty('confirm');
    expect(usersCreate.required).toContain('email');
  });
});

function responsesOf(
  pattern: string,
  method: string
): Record<string, { content?: Record<string, { schema?: Schema }> }> {
  const operation = buildOpenApiDocument().paths[pattern]?.[method];
  if (operation === undefined) {
    throw new Error(`openapi test: no operation for ${method} ${pattern}`);
  }
  return operation.responses;
}

function jsonResult(pattern: string, method: string): Schema {
  const schema = responsesOf(pattern, method)['200']?.content?.[
    'application/json'
  ]?.schema;
  if (schema === undefined) {
    throw new Error(`openapi test: no JSON result for ${method} ${pattern}`);
  }
  return schema;
}

describe('the OpenAPI responses describe what each operation answers (§10.3)', () => {
  it('documents a list as a page of its items and the next cursor', () => {
    const page = jsonResult('/users', 'get');
    expect(page.required).toEqual(['items', 'nextCursor']);
    expect(accepts(page, { items: [], nextCursor: 'abc' })).toBe(true);
    expect(accepts(page, { items: [], nextCursor: null })).toBe(true);
    expect(accepts(page, { items: [{ id: 'u1' }], nextCursor: null })).toBe(
      false
    );
    expect(accepts(page, { items: [] })).toBe(false);
  });

  it('documents a write’s result with the warnings its commit may add', () => {
    const presence = jsonResult('/users/{id}/presence', 'put');
    expect(accepts(presence, { id: 'u1', dnd: true })).toBe(true);
    expect(
      accepts(presence, { id: 'u1', dnd: true, warnings: ['not propagated'] })
    ).toBe(true);
    expect(accepts(presence, { id: 'u1', dnd: 'on' })).toBe(false);
    expect(jsonResult('/users/{id}', 'get').properties).not.toHaveProperty(
      'warnings'
    );
  });

  it('documents a file download as its bytes in each media type, never as JSON', () => {
    const content = responsesOf('/voicemails/{id}/audio', 'get')['200']
      ?.content;
    expect(Object.keys(content ?? {}).sort()).toEqual([
      'audio/mpeg',
      'audio/ogg',
      'audio/wav'
    ]);
  });

  it.each([
    ['/users', 'get', ['401', '403', '422']],
    ['/users/{id}', 'get', ['401', '403', '404', '422']],
    ['/users/{id}', 'delete', ['400', '401', '403', '404', '409', '422']],
    ['/users/{id}/presence', 'put', ['400', '401', '403', '404', '422']]
  ])(
    '%s %s documents exactly the problem statuses it answers with',
    (pattern, method, statuses) => {
      const problems = Object.entries(responsesOf(pattern, method)).filter(
        ([status]) => status !== '200'
      );
      expect(problems.map(([status]) => status)).toEqual(statuses);
      for (const [, response] of problems) {
        expect(response.content).toHaveProperty(['application/problem+json']);
      }
    }
  );
});
