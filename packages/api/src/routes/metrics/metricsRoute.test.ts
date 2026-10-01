import { randomUUID } from 'node:crypto';
import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';

import type { CoreHealth, StateResponse } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '$lib/server/db.js';

import { GET } from './+server.js';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const EMPTY_STATE: StateResponse = {
  calls: [],
  trunks: {},
  trunkChannels: {},
  registeredDevices: 0,
  recordingMixFailures: 0,
  asteriskChannels: 0,
  recordingsInProgress: 0,
  presence: {}
};

process.env.DB_FILE = ':memory:';

const realFetch = globalThis.fetch;
const originalToken = process.env.METRICS_TOKEN;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (originalToken === undefined) {
    delete process.env.METRICS_TOKEN;
  } else {
    process.env.METRICS_TOKEN = originalToken;
  }
});

/** `input` as the URL string `fetch` was called with, whichever of its three accepted shapes. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function stubCore(): void {
  globalThis.fetch = (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.endsWith('/healthz')) {
      const body: CoreHealth = { ok: true, ari: true, db: true };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' }
        })
      );
    }
    if (url.endsWith('/internal/state')) {
      return Promise.resolve(
        new Response(JSON.stringify(EMPTY_STATE), {
          headers: { 'content-type': 'application/json' }
        })
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  };
}

function eventWithAuth(authorization: string | null): RequestEvent {
  const headers = new Headers();
  if (authorization !== null) {
    headers.set('authorization', authorization);
  }
  return {
    request: new Request('http://api/metrics', { headers })
  } as RequestEvent;
}

describe('GET /metrics', () => {
  it('is 404 while METRICS_TOKEN is unset', async () => {
    delete process.env.METRICS_TOKEN;
    stubCore();

    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const response = await GET(eventWithAuth('Bearer anything'));

    expect(response.status).toBe(HTTP_NOT_FOUND);
  });

  it('is 401 on a missing or wrong bearer token', async () => {
    process.env.METRICS_TOKEN = randomUUID();
    stubCore();

    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const missing = await GET(eventWithAuth(null));
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const wrong = await GET(eventWithAuth('Bearer wrong-token'));

    expect(missing.status).toBe(HTTP_UNAUTHORIZED);
    expect(wrong.status).toBe(HTTP_UNAUTHORIZED);
  });

  it('answers 200 with the Prometheus text body on the right bearer token', async () => {
    const token = randomUUID();
    process.env.METRICS_TOKEN = token;
    stubCore();
    await migrateForTest(getDb());

    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const response = await GET(eventWithAuth(`Bearer ${token}`));

    expect(response.status).toBe(HTTP_OK);
    const text = await response.text();
    expect(text).toContain('zamfono_active_calls');
  });
});
