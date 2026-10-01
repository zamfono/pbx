import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { register } from '../ops/registry.js';
import { defineOperation } from '../ops/types.js';
import { listTools } from './tools.js';

register(
  defineOperation<{ data: Buffer }, { id: string }>({
    name: 'test.upload',
    description: 'uploads binary data',
    // `ops/audio/create.ts` carries the same shape: a multipart upload's bytes have no JSON
    // Schema of their own, so the tool schema has to fall back to an unconstrained value.
    input: z.object({ data: z.instanceof(Buffer) }),
    minRole: 'admin',
    entity: (_input, out) => ({ kind: 'test', id: out.id }),
    run: () => Promise.resolve({ id: 'u1' })
  })
);

register(
  defineOperation<{ id: string }, { id: string }>({
    name: 'test.remove',
    description: 'removes a thing',
    input: z.object({ id: z.string() }).strict(),
    minRole: 'admin',
    confirm: input => `Remove '${input.id}'?`,
    entity: input => ({ kind: 'test', id: input.id }),
    run: (_ctx, input) => Promise.resolve({ id: input.id })
  })
);

describe('listTools', () => {
  it("lets a destructive tool's input carry `confirm: true`, the fallback's second call (§10.5)", () => {
    const remove = listTools().find(tool => tool.name === 'test.remove');
    expect(remove?.annotations.destructiveHint).toBe(true);
    const validator = z.fromJSONSchema(
      remove?.inputSchema as Parameters<typeof z.fromJSONSchema>[0]
    );
    expect(validator.safeParse({ id: 'x1', confirm: true }).success).toBe(true);
    // Elicitation asks first, so the unconfirmed call is a valid input too; unknown keys are not.
    expect(validator.safeParse({ id: 'x1' }).success).toBe(true);
    expect(validator.safeParse({ id: 'x1', force: true }).success).toBe(false);
  });

  it('exports a tool schema for an operation whose input has no JSON Schema representation', () => {
    const tools = listTools();
    const upload = tools.find(tool => tool.name === 'test.upload');
    expect(upload?.inputSchema).toMatchObject({
      type: 'object',
      properties: { data: {} }
    });
  });

  it('sorts tools by code point and always offers the help tool', () => {
    const names = listTools().map(tool => tool.name);
    expect(names).toContain('zamfono.help');
    expect([...names].sort()).toEqual(names);
  });
});
