import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { listTools } from './tools.js';

describe('listTools', () => {
  it("lets a destructive tool's input carry `confirm: true`, the fallback's second call (§10.5)", () => {
    const remove = listTools().find(tool => tool.name === 'users.delete');
    expect(remove?.annotations.destructiveHint).toBe(true);
    const validator = z.fromJSONSchema(
      remove?.inputSchema as Parameters<typeof z.fromJSONSchema>[0]
    );
    expect(validator.safeParse({ id: 'x1', confirm: true }).success).toBe(true);
    // Elicitation asks first, so the unconfirmed call is a valid input too; unknown keys are not.
    expect(validator.safeParse({ id: 'x1' }).success).toBe(true);
    expect(validator.safeParse({ id: 'x1', force: true }).success).toBe(false);
  });

  // A multipart upload's bytes have no JSON Schema of their own, so the tool schema falls back to
  // an unconstrained value.
  it('publishes an upload operation without its file, which its upload link takes (§10.5)', () => {
    const tools = listTools();
    const upload = tools.find(tool => tool.name === 'audio.create');
    expect(upload?.inputSchema).toMatchObject({
      type: 'object',
      properties: { kind: {}, label: {} }
    });
    expect(upload?.inputSchema).not.toHaveProperty('properties.upload');
  });

  it('publishes the object a tool answers with as its output schema (§10.5)', () => {
    const tools = listTools();
    const get = tools.find(tool => tool.name === 'users.get');
    expect(get?.outputSchema).toMatchObject({
      type: 'object',
      properties: { id: {}, email: {} }
    });
    // A file and an upload answer with their link, not with the operation's own result.
    for (const name of ['voicemails.audio', 'audio.create']) {
      expect(tools.find(tool => tool.name === name)?.outputSchema).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { url: { type: 'string' }, expiresAt: { type: 'string' } },
        required: ['url', 'expiresAt'],
        additionalProperties: false
      });
    }
  });

  it("publishes the help tool's two answers, the topic list and one topic, as one output schema", () => {
    const help = listTools().find(tool => tool.name === 'zamfono.help');
    expect(help?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        topics: { type: 'array', items: { type: 'string' } },
        topic: { type: 'string' },
        content: { type: 'string' }
      },
      additionalProperties: false
    });
    expect(help?.outputSchema).not.toHaveProperty('required');
  });

  it('sorts tools by code point and always offers the help tool', () => {
    const names = listTools().map(tool => tool.name);
    expect(names).toContain('zamfono.help');
    expect([...names].sort()).toEqual(names);
  });
});
