import { describe, expect, it } from 'vitest';

import {
  currentRequest,
  rpc,
  seededDeps,
  SERVER_INFO_META
} from '#testing/mcp/testKit.js';
import { legacyRequest, legacySession } from '#testing/mcp/testKitLegacy.js';

// `prompts/get` against the recipes bundled from `docs/guide/recipes/` (§10.5 "Prompts"), in the
// shapes of https://modelcontextprotocol.io/specification/2026-07-28/server/prompts and
// https://modelcontextprotocol.io/specification/2025-11-25/server/prompts.
const ONBOARD = {
  name: 'onboard-employee',
  arguments: { employeeName: 'Jane Doe', email: 'jane@example.com' }
};

type PromptBody = {
  description: string;
  messages: { role: string; content: { type: string; text: string } }[];
};

describe('prompts/get, 2026-07-28', () => {
  it('returns the recipe as a user message carrying the given arguments', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(1, 'prompts/get', ONBOARD)
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({
      resultType: 'complete',
      description: 'Onboard an employee',
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: expect.any(String) as string }
        }
      ],
      _meta: SERVER_INFO_META
    });
    const text = (body.result as PromptBody).messages[0]?.content.text;
    expect(text).toContain('Create the user: `users.create` (`POST /users`)');
    expect(text).not.toContain('required: true');
    expect(text).toMatch(
      /Parameters:\n- employeeName: "Jane Doe"\n- email: "jane@example\.com"$/u
    );
  });

  it('quotes an argument, so a newline in it cannot add a parameter line', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(1, 'prompts/get', {
        name: 'onboard-employee',
        arguments: { employeeName: 'Jane\n- extension: 666', email: 'j@x' }
      })
    );
    const text = (body.result as PromptBody).messages[0]?.content.text;
    expect(text).toContain('- employeeName: "Jane\\n- extension: 666"');
  });

  it('answers an unknown prompt with -32602', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(2, 'prompts/get', { name: 'no-such-recipe' })
    );
    expect(body.result).toBeUndefined();
    expect(body.error).toEqual({
      code: -32602,
      message: 'Unknown prompt: no-such-recipe'
    });
  });

  it.each([{ employeeName: 'Jane' }, { employeeName: 'Jane', email: '' }])(
    'answers a missing required argument, blank or absent, with -32602: %o',
    async args => {
      const body = await rpc(
        await seededDeps(),
        currentRequest(3, 'prompts/get', {
          name: 'onboard-employee',
          arguments: args
        })
      );
      expect(body.error).toEqual({
        code: -32602,
        message: 'Missing required argument: email'
      });
    }
  );

  it.each([
    { name: 'undo', arguments: { colour: 'blue' } },
    { name: 'undo', arguments: { entityId: 5 } },
    { name: 'undo', arguments: ['entityId'] },
    {}
  ])(
    'answers an undeclared or non-string argument, or no name, with -32602: %o',
    async params => {
      const body = await rpc(
        await seededDeps(),
        currentRequest(4, 'prompts/get', params)
      );
      expect(body.error?.code).toBe(-32602);
    }
  );

  it('needs no arguments for a recipe whose parameters are all optional', async () => {
    const body = await rpc(
      await seededDeps(),
      currentRequest(5, 'prompts/get', { name: 'undo' })
    );
    const text = (body.result as PromptBody).messages[0]?.content.text;
    expect(text).not.toContain('Parameters:');
  });
});

describe('prompts/get, legacy 2025-11-25', () => {
  it('returns a GetPromptResult without the 2026-07-28 fields', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps);
    const body = await rpc(
      deps,
      legacyRequest(headers, 1, 'prompts/get', ONBOARD)
    );
    expect(body.result).toEqual({
      description: 'Onboard an employee',
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: expect.any(String) as string }
        }
      ]
    });
    const missing = await rpc(
      deps,
      legacyRequest(headers, 2, 'prompts/get', { name: 'onboard-employee' })
    );
    expect(missing.error?.code).toBe(-32602);
  });
});
