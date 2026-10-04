import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  confirmationProblem,
  mcpRequest,
  seededDeps,
  type RpcBody
} from '#testing/mcp/testKit.js';
import {
  legacyRequest,
  legacySession,
  readSseEvents
} from '#testing/mcp/testKitLegacy.js';

import { handleMcpRequest } from '../mcp.js';
import { register } from '../ops/registry.js';
import { defineOperation } from '../ops/types.js';

// A confirm-guarded operation only an owner may call, to see which role its confirmed run acts
// with.
const ownerRuns: string[] = [];
register(
  defineOperation<{ id: string }, { deleted: string }>({
    name: 'test.ownerDelete',
    description: 'deletes a thing, owners only',
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.string() }),
    minRole: 'owner',
    confirm: (_ctx, input) => `Delete ${input.id}?`,
    audit: false,
    run: (_ctx, input) => {
      ownerRuns.push(input.id);
      return Promise.resolve({ deleted: input.id });
    }
  })
);

// A legacy 2025-11-25 session's confirmation, asked as a server-initiated `elicitation/create`
// on the tools/call's SSE stream (§10.5), when the person never answers it.
const ELICITATION_TIMEOUT_MS = 300_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('legacy elicitation timeout', () => {
  it('cancels the question and mirrors the REST confirmation contract', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps, { elicitation: {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = await handleMcpRequest(
      deps,
      legacyRequest(headers, 9, 'tools/call', {
        name: 'test.delete',
        arguments: { id: 't8' }
      })
    );
    const events = readSseEvents(response);
    const elicit = (await events.next()).value as { id: string };

    vi.advanceTimersByTime(ELICITATION_TIMEOUT_MS);

    expect((await events.next()).value).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: elicit.id, reason: 'elicitation timed out' }
    });
    const settled = (await events.next()).value as RpcBody;
    expect(settled.id).toBe(9);
    expect(settled.error).toBeUndefined();
    expect(settled.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(confirmationProblem('Delete t8?'))
        }
      ],
      structuredContent: confirmationProblem('Delete t8?'),
      isError: true
    });
    expect((await events.next()).done).toBe(true);

    // A late answer finds nothing pending: it is not a response this process is waiting for.
    const late = await handleMcpRequest(
      deps,
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: elicit.id,
          result: { action: 'accept', content: { confirm: true } }
        },
        headers
      )
    );
    expect(late.status).not.toBe(202);
  });
});

describe('legacy elicitation stream', () => {
  it('asks a buffering proxy not to hold the stream back', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps, { elicitation: {} });
    const response = await handleMcpRequest(
      deps,
      legacyRequest(headers, 10, 'tools/call', {
        name: 'test.delete',
        arguments: { id: 't9' }
      })
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    // Disconnecting drops the pending question and its timer.
    await response.body?.cancel();
  });
});

describe('legacy elicitation answer', () => {
  it('runs with the role the user holds when they answer (§5.3)', async () => {
    const deps = await seededDeps();
    const headers = await legacySession(deps, { elicitation: {} });
    const response = await handleMcpRequest(
      deps,
      legacyRequest(headers, 11, 'tools/call', {
        name: 'test.ownerDelete',
        arguments: { id: 't10' }
      })
    );
    const events = readSseEvents(response);
    const elicit = (await events.next()).value as { id: string };

    // Demoted while the question is open.
    await deps.db
      .updateTable('users')
      .set({ role: 'admin' })
      .where('id', '=', 'owner')
      .execute();
    const answered = await handleMcpRequest(
      deps,
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: elicit.id,
          result: { action: 'accept', content: { confirm: true } }
        },
        headers
      )
    );
    expect(answered.status).toBe(202);

    const settled = (await events.next()).value as RpcBody;
    expect(settled.result).toMatchObject({
      isError: true,
      structuredContent: { status: 403 }
    });
    expect(ownerRuns).toEqual([]);
  });
});
