import { randomUUID } from 'node:crypto';
import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  type StateResponse
} from '@zamfono/shared';
import { migrateForTest, seedSettings } from '@zamfono/shared/testDb.js';

import { getCoreClient } from '#lib/server/coreClient.js';
import { getDb } from '#lib/server/db.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { requestEvent } from '#testing/requestEvent.js';

import { GET } from './+server.js';

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

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
  vi.unstubAllEnvs();
});

function stubCore(): void {
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({
      health: () =>
        Promise.resolve({
          status: 'pass',
          checks: {
            'core:database': [{ status: 'pass' }],
            'core:ari': [{ status: 'pass' }]
          }
        }),
      state: () => Promise.resolve(EMPTY_STATE)
    })
  );
}

function eventWithAuth(authorization: string | null): RequestEvent {
  return requestEvent('http://api/metrics', {
    init: {
      headers: authorization === null ? {} : { authorization }
    }
  });
}

describe('GET /metrics', () => {
  it('is 404 while METRICS_TOKEN is unset', async () => {
    vi.stubEnv('METRICS_TOKEN', undefined);
    stubCore();

    const response = await GET(eventWithAuth('Bearer anything'));

    expect(response.status).toBe(HTTP_NOT_FOUND);
  });

  it('is 401 on a missing or wrong bearer token', async () => {
    vi.stubEnv('METRICS_TOKEN', randomUUID());
    stubCore();

    const missing = await GET(eventWithAuth(null));
    const wrong = await GET(eventWithAuth('Bearer wrong-token'));

    expect(missing.status).toBe(HTTP_UNAUTHORIZED);
    expect(wrong.status).toBe(HTTP_UNAUTHORIZED);
  });

  it('answers 200 with the Prometheus text body on the right bearer token', async () => {
    const token = randomUUID();
    vi.stubEnv('METRICS_TOKEN', token);
    stubCore();
    await migrateForTest(getDb());
    await seedSettings(getDb());

    const response = await GET(eventWithAuth(`Bearer ${token}`));

    expect(response.status).toBe(HTTP_OK);
    const text = await response.text();
    expect(text).toContain('zamfono_active_calls');
  });
});
