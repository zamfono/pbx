import { describe, expect, it, vi } from 'vitest';

import {
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_SERVICE_UNAVAILABLE
} from '@zamfono/shared';

import { createCoreClient } from './coreClient.js';
import { CoreRequestError } from './coreHttp.js';

const HANG_TIMEOUT_MS = 10;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** A 204 No Content response: the `Response` constructor rejects a body alongside that status. */
function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

function serverErrorResponse(): Response {
  return jsonResponse(HTTP_INTERNAL_SERVER_ERROR, { type: 'about:blank' });
}

describe('createCoreClient', () => {
  it('posts the reload kinds to /internal/configChanged', async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContentResponse());
    const client = createCoreClient('http://core:3000', fetchFn);

    await client.configChanged(['pjsip', 'dialplan']);

    expect(fetchFn).toHaveBeenCalledWith(
      'http://core:3000/internal/configChanged',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reload: ['pjsip', 'dialplan'] })
      })
    );
  });

  it('GETs /internal/state and returns the parsed snapshot', async () => {
    const snapshot = { calls: [], trunks: {}, presence: {} };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, snapshot));
    const client = createCoreClient('http://core:3000', fetchFn);

    await expect(client.state()).resolves.toEqual(snapshot);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://core:3000/internal/state');
  });

  it('originate returns the callId on 201', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { callId: 'c1' }));
    const client = createCoreClient('http://core:3000', fetchFn);

    await expect(
      client.originate({
        userId: 'u1',
        target: '+15551234',
        actorUserId: 'u1',
        requestId: 'r1'
      })
    ).resolves.toEqual({ callId: 'c1' });
  });

  it('originate reports noRegisteredDevice on a 409 naming that cause', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        type: 'about:blank',
        title: 'no registered device',
        status: 409,
        detail: 'noRegisteredDevice'
      })
    );
    const client = createCoreClient('http://core:3000', fetchFn);

    await expect(
      client.originate({
        userId: 'u1',
        target: '+15551234',
        actorUserId: 'u1',
        requestId: 'r1'
      })
    ).resolves.toEqual({ error: 'noRegisteredDevice' });
  });

  it('pushes MWI for a mailbox', async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContentResponse());
    const client = createCoreClient('http://core:3000', fetchFn);

    await client.mwi('user:u1');

    expect(fetchFn).toHaveBeenCalledWith(
      'http://core:3000/internal/mwi/user:u1',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects with CoreRequestError on a 500, one per verb', async () => {
    const fetchFn = vi.fn().mockResolvedValue(serverErrorResponse());
    const client = createCoreClient('http://core:3000', fetchFn);
    const calls: (() => Promise<unknown>)[] = [
      () => client.configChanged(['pjsip']),
      () => client.state(),
      () =>
        client.originate({
          userId: 'u1',
          target: '+15551234',
          actorUserId: 'u1',
          requestId: 'r1'
        }),
      () => client.transfer('c1', { target: '102', actorUserId: 'u1' }),
      () => client.pickup('c1', { userId: 'u2', actorUserId: 'u2' }),
      () => client.hangup('c1', { actorUserId: 'u1' }),
      () => client.mwi('user:u1')
    ];

    const outcomes = await Promise.all(
      calls.map(call =>
        call().then(
          () => null,
          (error: unknown) => error
        )
      )
    );

    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(CoreRequestError);
      expect((outcome as CoreRequestError).status).toBe(
        HTTP_INTERNAL_SERVER_ERROR
      );
    }
  });

  it('proxies transfer, pickup and hangup to their call-scoped routes', async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContentResponse());
    const client = createCoreClient('http://core:3000', fetchFn);

    await client.transfer('c1', { target: '102', actorUserId: 'u1' });
    await client.pickup('c1', { userId: 'u2', actorUserId: 'u2' });
    await client.hangup('c1', { actorUserId: 'u1' });

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'http://core:3000/internal/calls/c1/transfer',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'http://core:3000/internal/calls/c1/pickup',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      'http://core:3000/internal/calls/c1/hangup',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('CoreClient.health', () => {
  it("returns core's body on a 503 too, since it says which check is down", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse(HTTP_SERVICE_UNAVAILABLE, {
          ok: false,
          ari: false,
          db: true
        })
      )
    );

    const health = await createCoreClient('http://core:3000', fetchFn).health();

    expect(health).toEqual({ ok: false, ari: false, db: true });
    expect(fetchFn).toHaveBeenCalledWith('http://core:3000/healthz', {
      signal: expect.any(AbortSignal) as unknown
    });
  });
});

// `/healthz`, `/metrics`, `system.info` and every live-call action ask these of `core`: none of
// them hangs with a `core` that accepts the request and never answers it.
describe.each(['health', 'version', 'state'] as const)(
  'CoreClient.%s',
  method => {
    it('rejects once its timeout aborts a request core never answers', async () => {
      const fetchFn = (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(
        AbortSignal.timeout(HANG_TIMEOUT_MS)
      );

      await expect(
        createCoreClient('http://core:3000', fetchFn)[method]()
      ).rejects.toThrow('aborted');
    });
  }
);
