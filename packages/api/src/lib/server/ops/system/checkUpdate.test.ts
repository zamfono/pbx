import { afterEach, describe, expect, it, vi } from 'vitest';

import { HTTP_OK, HTTP_SERVICE_UNAVAILABLE } from '@zamfono/shared';

import { problemFromError } from '#lib/server/problem.js';
import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

const asAdmin: RunInput = {
  actor: { id: 'a1', name: 'Admin', role: 'admin' },
  channel: 'mcp',
  requestId: 'req-1'
};
const STATUS = {
  current: '0.0.6',
  latest: { version: '0.0.7', url: 'https://example', publishedAt: '' },
  updatable: true,
  breaking: false,
  last: { state: 'idle' }
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** An updater at `http://updater.test` answering every request with `response`. */
function updaterAnswering(response: () => Response): string[] {
  vi.stubEnv('UPDATER_TOKEN', 'token');
  vi.stubEnv('UPDATER_URL', 'http://updater.test');
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    return Promise.resolve(response());
  });
  return asked;
}

describe('system.checkUpdate', () => {
  it('has the updater ask GitHub now, and answers with the update block of system.info', async () => {
    const asked = updaterAnswering(() =>
      Response.json(STATUS, { status: HTTP_OK })
    );
    const db = await makeTestDb();
    expect(await runOperation(db, 'system.checkUpdate', {}, asAdmin)).toEqual(
      STATUS
    );
    expect(asked).toEqual(['POST http://updater.test/check']);
  });

  it('says why there is no update block without UPDATER_TOKEN', async () => {
    const db = await makeTestDb();
    expect(await runOperation(db, 'system.checkUpdate', {}, asAdmin)).toEqual({
      unavailable:
        'UPDATER_TOKEN is not set in .env; updates run only by update.sh on the host'
    });
  });

  it('answers a spent GitHub rate limit with 503 and when to retry', async () => {
    updaterAnswering(() =>
      Response.json(
        { error: 'GitHub answered 403: its rate limit is spent' },
        {
          status: HTTP_SERVICE_UNAVAILABLE,
          headers: { 'retry-after': '120' }
        }
      )
    );
    const db = await makeTestDb();
    const error: unknown = await runOperation(
      db,
      'system.checkUpdate',
      {},
      asAdmin
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: HTTP_SERVICE_UNAVAILABLE,
      detail: { retryAfterS: 120 }
    });
    const response = problemFromError(error);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(await response.json()).toMatchObject({
      title: 'system.checkUpdate: GitHub answered 403: its rate limit is spent',
      retryAfterS: 120
    });
  });
});
