import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  HTTP_FORBIDDEN,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE
} from '@zamfono/shared';

import { problemFromError } from '#lib/server/problem.js';
import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

const asAdmin: RunInput = {
  actor: { id: 'a1', name: 'Admin', role: 'admin' },
  channel: 'mcp',
  requestId: 'req-1'
};
const LATEST = 'https://api.github.com/repos/zamfono/pbx/releases/latest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A stack at 0.0.6 whose host agent has run, and GitHub answering every request with
 * `response`; the URLs asked. */
async function stackAsking(response: () => Response): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-update-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'agent'), '2026-11-12T10:00:00.000Z\n');
  await writeFile(path.join(dir, 'stack.json'), '{ "current": "0.0.6" }\n');
  vi.stubEnv('UPDATER_TOKEN', 'token');
  vi.stubEnv('UPDATE_DIR', dir);
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    return Promise.resolve(response());
  });
  return asked;
}

describe('system.checkUpdate', () => {
  it('asks GitHub now, and answers with the update block of system.info', async () => {
    const asked = await stackAsking(() =>
      Response.json(
        {
          tag_name: 'v0.0.7',
          html_url: 'https://example',
          published_at: '2026-11-12T00:00:00Z'
        },
        { status: HTTP_OK }
      )
    );
    const db = await makeTestDb();
    expect(await runOperation(db, 'system.checkUpdate', {}, asAdmin)).toEqual({
      current: '0.0.6',
      latest: {
        version: '0.0.7',
        url: 'https://example',
        publishedAt: '2026-11-12T00:00:00Z'
      },
      updatable: true,
      breaking: false,
      last: { state: 'idle' }
    });
    expect(asked).toEqual([LATEST]);
  });

  it('says why there is no update block without UPDATER_TOKEN', async () => {
    const db = await makeTestDb();
    expect(await runOperation(db, 'system.checkUpdate', {}, asAdmin)).toEqual({
      unavailable:
        'UPDATER_TOKEN is not set in .env; updates run only by update.sh on the host'
    });
  });

  it('answers a spent GitHub rate limit with 503 and when to retry', async () => {
    await stackAsking(
      () =>
        new Response('{}', {
          status: HTTP_FORBIDDEN,
          headers: { 'x-ratelimit-remaining': '0', 'retry-after': '120' }
        })
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
      title: `system.checkUpdate: GitHub answered 403 for ${LATEST}: its rate limit for this address is spent`,
      retryAfterS: 120
    });
  });
});
