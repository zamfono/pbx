import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HTTP_SERVICE_UNAVAILABLE, type CoreHealth } from '@zamfono/shared';
import { MIGRATIONS_DIR } from '@zamfono/shared/testDb.js';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#lib/server/coreClientStub.js';

import { GET } from './+server.js';

const KEY_BYTE_LENGTH = 32;

// `getDb()` reads `DB_FILE` once per process, the route `MIGRATIONS_DIR` and `SECRETBOX_KEY` per
// request; an in-memory, unmigrated database is enough since these tests only care about the
// `core` field the route derives.
process.env.DB_FILE = ':memory:';
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

// Set above, so always defined; restored after the one test that deletes it.
const originalSecretboxKey = process.env.SECRETBOX_KEY;

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
  process.env.SECRETBOX_KEY = originalSecretboxKey;
});

/** Has core's `/healthz` answer `body`, whatever its status: a 503 still carries one. */
function stubCoreHealthz(body: CoreHealth): void {
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({ health: () => Promise.resolve(body) })
  );
}

describe('GET /healthz', () => {
  it('reports core reachable with its own ari flag when core answers 200', async () => {
    stubCoreHealthz({ ok: true, ari: true, db: true });
    const response = await GET();
    const body = (await response.json()) as { core: unknown };
    expect(body.core).toEqual({ reachable: true, ari: true });
  });

  it('keeps core reachable but ari false when core answers 503 with ari down', async () => {
    stubCoreHealthz({
      ok: false,
      ari: false,
      db: true
    });
    const response = await GET();
    const body = (await response.json()) as { core: unknown };
    expect(body.core).toEqual({ reachable: true, ari: false });
  });

  it('reports core unreachable when the request itself fails', async () => {
    const response = await GET();
    const body = (await response.json()) as { core: unknown };
    expect(body.core).toEqual({ reachable: false, ari: false });
  });

  it('is 503 while the database holds no migration record', async () => {
    stubCoreHealthz({ ok: true, ari: true, db: true });
    const response = await GET();
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
  });
});
