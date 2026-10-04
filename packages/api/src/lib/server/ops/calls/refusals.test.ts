import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoreClient, getCoreClient } from '#lib/server/coreClient.js';
import { handleRest } from '#lib/server/rest.js';
import { makeTestDb, owner } from '#testing/testDb.js';

import './index.js';

const CALL_ID = 'call-1';

/** A real `CoreClient` over a `fetch` that answers every request as `core` refusing it does
 * (`internal/actionRoutes.ts`): the status, and an RFC 9457 problem whose `detail` is the reason. */
function coreRefusing(status: number, title: string, reason: string): void {
  const fetchFn = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ type: 'about:blank', title, status, detail: reason }),
        { status, headers: { 'content-type': 'application/problem+json' } }
      )
    )) as typeof fetch;
  vi.mocked(getCoreClient).mockReturnValue(
    createCoreClient('http://core.test', fetchFn)
  );
}

/** A real `CoreClient` over a `fetch` that never reaches `core`. */
function coreSilent(): void {
  vi.mocked(getCoreClient).mockReturnValue(
    createCoreClient('http://core.test', () =>
      Promise.reject(new TypeError('fetch failed'))
    )
  );
}

async function post(path: string, body: unknown): Promise<Response> {
  return handleRest(
    new Request(`http://pbx.test/api/v1/calls/${CALL_ID}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    owner,
    { db: await makeTestDb(), requestId: 'req-1' }
  );
}

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
});

// §10.3: errors are RFC 9457 problems; a refusal `core` answers keeps its status and reason, as
// `calls.originate`'s `noRegisteredDevice` does (§10.2 "Click-to-dial"); any other failure is a 503.
describe('a live-call action core refuses', () => {
  it('answers a transfer of an unbridged call with 409 notBridged', async () => {
    coreRefusing(409, 'call is not bridged', 'notBridged');
    const response = await post('transfer', { target: '102' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      title: 'call is not bridged',
      detail: 'notBridged'
    });
  });

  it('answers a pickup of a call that stopped ringing with 409 notRinging', async () => {
    coreRefusing(409, 'call is not ringing', 'notRinging');
    const response = await post('pickup', {});
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      detail: 'notRinging'
    });
  });

  it('answers a pickup by a user without a registered device with 409 noRegisteredDevice', async () => {
    coreRefusing(409, 'no registered device', 'noRegisteredDevice');
    const response = await post('pickup', {});
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      detail: 'noRegisteredDevice'
    });
  });

  it('answers a hangup of a call core holds no live state for with 404 notFound', async () => {
    coreRefusing(404, 'call not found', 'notFound');
    const response = await post('hangup', {});
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      title: 'call not found',
      detail: 'notFound'
    });
  });

  it('answers any other core failure with 503', async () => {
    coreRefusing(500, 'internal', 'boom');
    const response = await post('hangup', {});
    expect(response.status).toBe(503);
  });

  it('answers 503 while core does not answer', async () => {
    coreSilent();
    const response = await post('hangup', {});
    expect(response.status).toBe(503);
  });
});

describe('a read from core while core does not answer', () => {
  it('answers the live calls list with 503', async () => {
    coreSilent();
    const response = await handleRest(
      new Request('http://pbx.test/api/v1/calls?live=true'),
      owner,
      { db: await makeTestDb(), requestId: 'req-1' }
    );
    expect(response.status).toBe(503);
  });
});
