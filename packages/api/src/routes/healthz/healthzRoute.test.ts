import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HTTP_SERVICE_UNAVAILABLE, type HealthDocument } from '@zamfono/shared';
import { MIGRATIONS_DIR } from '@zamfono/shared/testDb.js';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';

import { GET } from './+server.js';

const KEY_BYTE_LENGTH = 32;

// `getDb()` reads `DB_FILE` once per process, the route `MIGRATIONS_DIR` and `SECRETBOX_KEY` per
// request; an in-memory, unmigrated database is enough since these tests only care about the
// checks the route derives beside the tables.
process.env.DB_FILE = ':memory:';
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
});

/** Has core's `/healthz` answer `document`, whatever its status: a 503 still carries one. */
function stubCoreHealthz(document: HealthDocument): void {
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({ health: () => Promise.resolve(document) })
  );
}

async function documentOf(response: Response): Promise<HealthDocument> {
  return (await response.json()) as HealthDocument;
}

describe('GET /healthz', () => {
  it('answers application/health+json, never cached', async () => {
    const response = await GET();
    expect(response.headers.get('content-type')).toBe(
      'application/health+json'
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it("copies core's own checks with core reachable, a 503 of core's included", async () => {
    stubCoreHealthz({
      status: 'fail',
      checks: {
        'core:database': [{ status: 'pass' }],
        'core:ari': [{ status: 'fail' }]
      }
    });
    const { checks } = await documentOf(await GET());
    expect(checks['core:reachable']).toEqual([{ status: 'pass' }]);
    expect(checks['core:database']).toEqual([{ status: 'pass' }]);
    expect(checks['core:ari']).toEqual([{ status: 'fail' }]);
  });

  it('fails core:reachable, with no core:* check besides, when the request itself fails', async () => {
    const { checks } = await documentOf(await GET());
    expect(checks['core:reachable']).toEqual([{ status: 'fail' }]);
    expect(checks).not.toHaveProperty('core:ari');
  });

  it('fails sipBan:helper while the helper wrote no heartbeat (§9.1)', async () => {
    const { checks } = await documentOf(await GET());
    expect(checks['sipBan:helper']).toEqual([{ status: 'fail' }]);
  });

  it('is 503 with database:status failing while the database holds no migration record', async () => {
    stubCoreHealthz({
      status: 'pass',
      checks: {
        'core:database': [{ status: 'pass' }],
        'core:ari': [{ status: 'pass' }]
      }
    });
    const response = await GET();
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    const document = await documentOf(response);
    expect(document.status).toBe('fail');
    expect(document.checks['database:status']).toEqual([
      { status: 'fail', output: 'migrationPending' }
    ]);
  });
});
