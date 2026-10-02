import { describe, expect, it, vi } from 'vitest';

import { createCoreClient } from './coreClient.js';
import { coreRefusal } from './coreHttp.js';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_UNPROCESSABLE = 422;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('createCoreClient call control', () => {
  it('posts each action to its core route and reads the call a dialling one started', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(HTTP_CREATED, { callId: 'c2' }))
      .mockResolvedValue(new Response(null, { status: HTTP_NO_CONTENT }));
    const client = createCoreClient('http://core:3000', fetchFn);

    await expect(
      client.consult('c 1', { target: '102', actorUserId: 'u1' })
    ).resolves.toEqual({ callId: 'c2' });
    await client.attendedTransfer('c1', { toCallId: 'c2', actorUserId: 'u1' });
    await client.hold('c1', { actorUserId: 'u1' });
    await client.decline('c1', { actorUserId: 'u1' });

    expect(fetchFn.mock.calls.map(([url]) => url as string)).toEqual([
      'http://core:3000/internal/calls/c%201/consult',
      'http://core:3000/internal/calls/c1/attendedTransfer',
      'http://core:3000/internal/calls/c1/hold',
      'http://core:3000/internal/calls/c1/decline'
    ]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ target: '102', actorUserId: 'u1' })
      })
    );
  });

  it('rejects with core’s refusal, a 422 among them', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(HTTP_UNPROCESSABLE, {
        type: 'about:blank',
        title: 'no party answers on this target',
        status: HTTP_UNPROCESSABLE,
        detail: 'invalidTarget'
      })
    );
    const client = createCoreClient('http://core:3000', fetchFn);
    const error: unknown = await client
      .addParty('c1', { target: '799', actorUserId: 'u1' })
      .catch((caught: unknown) => caught);
    expect(coreRefusal(error)).toEqual({
      status: HTTP_UNPROCESSABLE,
      title: 'no party answers on this target',
      detail: 'invalidTarget'
    });
  });
});
