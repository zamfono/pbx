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
  it('exports a tool schema for an operation whose input has no JSON Schema representation', () => {
    const tools = listTools();
    const upload = tools.find(tool => tool.name === 'audio.create');
    expect(upload?.inputSchema).toMatchObject({
      type: 'object',
      properties: { upload: { properties: { data: {} } } }
    });
  });

  it('sorts tools by code point and always offers the help tool', () => {
    const names = listTools().map(tool => tool.name);
    expect(names).toContain('zamfono.help');
    expect([...names].sort()).toEqual(names);
  });
});
