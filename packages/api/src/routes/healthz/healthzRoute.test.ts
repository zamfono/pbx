import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoreHealth } from '@zamfono/shared';

import { GET } from './+server.js';

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const KEY_BYTE_LENGTH = 32;

// `getDb()` and `keyringFromEnv()` read these once per process; an in-memory, unmigrated
// database is enough since these tests only care about the `core` field the route derives.
process.env.DB_FILE = ':memory:';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

const realFetch = globalThis.fetch;
// Set above, so always defined; restored after the one test that deletes it.
const originalSecretboxKey = process.env.SECRETBOX_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.SECRETBOX_KEY = originalSecretboxKey;
});

/** Stubs `globalThis.fetch` to answer core's `/healthz` with `status` and `body`. */
function stubCoreHealthz(status: number, body: CoreHealth): void {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    );
}

describe('GET /healthz', () => {
  it('reports core reachable with its own ari flag when core answers 200', async () => {
    stubCoreHealthz(HTTP_OK, { ok: true, ari: true, db: true });
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const response = await GET();
    const body = (await response.json()) as { core: unknown };
    expect(body.core).toEqual({ reachable: true, ari: true });
  });

  it('keeps core reachable but ari false when core answers 503 with ari down', async () => {
    stubCoreHealthz(HTTP_SERVICE_UNAVAILABLE, {
      ok: false,
      ari: false,
      db: true
    });
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const response = await GET();
    const body = (await response.json()) as { core: unknown };
    expect(body.core).toEqual({ reachable: true, ari: false });
  });

  it('reports core unreachable when the request itself fails', async () => {
    globalThis.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const response = await GET();
    const body = (await response.json()) as { core: unknown };
    expect(body.core).toEqual({ reachable: false, ari: false });
  });

  it('is 503 while the database holds no migration record', async () => {
    stubCoreHealthz(HTTP_OK, { ok: true, ari: true, db: true });
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const response = await GET();
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
  });

  it('reports keyRotationRemaining 0 instead of throwing when SECRETBOX_KEY is unset', async () => {
    stubCoreHealthz(HTTP_OK, { ok: true, ari: true, db: true });
    delete process.env.SECRETBOX_KEY;
    vi.resetModules();
    const { GET: freshGet } = await import('./+server.js');
    const response = await freshGet();
    const body = (await response.json()) as { keyRotationRemaining: number };
    expect(body.keyRotationRemaining).toBe(0);
  });
});
