import { afterEach, describe, expect, it } from 'vitest';

import { createCoreClient } from '$lib/server/coreClient.js';
import { handleRest } from '$lib/server/rest.js';
import { makeTestDb } from '$lib/server/testDb.js';

import { type Actor } from '../types.js';
import { setCoreClientForTest } from './_shared.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
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
  setCoreClientForTest(createCoreClient('http://core.test', fetchFn));
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
  setCoreClientForTest(createCoreClient());
});

// §10.3: errors are RFC 9457 problems; a refusal `core` answers keeps its status and reason, as
// `calls.originate`'s `noRegisteredDevice` does (§10.2 "Click-to-dial"), rather than a 500.
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

  it('keeps any other core failure a 500', async () => {
    coreRefusing(500, 'internal', 'boom');
    const response = await post('hangup', {});
    expect(response.status).toBe(500);
  });
});
