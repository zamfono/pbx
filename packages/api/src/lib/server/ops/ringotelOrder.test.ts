import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as privateEnv from '$app/env/private';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '@zamfono/shared';
import {
  migrateForTest,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import {
  installRingotelFake,
  type RingotelFake
} from '#testing/ringotelFake.js';

import { runOperation, type RunInput } from './runner.js';

import './index.js';

const owner: RunInput = {
  actor: { id: 'owner', name: 'Owner', role: 'owner' },
  channel: 'rest',
  requestId: 'req-1',
  confirm: true
};

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    // eslint-disable-next-line no-await-in-loop -- in reverse order of setup
    await cleanup();
  }
});

/** A deferred promise: `promise` settles once `resolve` is called. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A migrated database in a file, as deployed, with the `owner` user. */
async function fileDb(): Promise<{ db: Db; file: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'zamfono-ringotel-'));
  const file = path.join(dir, 'db.sqlite');
  const db = openDb(file);
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  cleanups.push(() => db.destroy());
  await migrateForTest(db);
  await seedUser(db, { id: 'owner', role: 'owner', passwordHash: 'x' });
  return { db, file };
}

/** A stack set up with the fake's Ringotel, user 998 and one `ringotel` device of theirs. */
async function ringotelDevice(
  db: Db
): Promise<{ fake: RingotelFake; deviceId: string }> {
  await seedSettings(db, {
    ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key'),
    ringotelOrgId: 'org-1',
    ringotelBranchId: 'branch-1'
  });
  const fake = installRingotelFake();
  cleanups.push(() => {
    fake.restore();
  });
  const userId = await seedUser(db, { ext: '998' });
  const created = (await runOperation(
    db,
    'devices.create',
    { userId, label: 'Phone', kind: 'ringotel' },
    owner
  )) as { device: { id: string } };
  return { fake, deviceId: created.device.id };
}

/** Holds each Ringotel request `hold` picks before the fake sees it, until `hold` settles. */
function delayRingotel(hold: (method: string) => Promise<void> | null): void {
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const { method } = JSON.parse(init?.body as string) as { method: string };
    await hold(method);
    return fakeFetch(url, init);
  }) as typeof fetch;
}

/**
 * Runs `operation` against the database in `file` while Ringotel holds its `method` request, and answers
 * what a write of another connection to that file (`core` stamping a registration, `/events`
 * recording a token's use) meanwhile did: `written`, or its error code. 100 ms of busy timeout
 * keeps the test short; the deployed 5 s only makes the wait longer.
 */
async function otherWriteWhileRingotelAnswers(
  file: string,
  method: string,
  operation: () => Promise<unknown>
): Promise<string | undefined> {
  const other = openDb(file);
  cleanups.push(() => other.destroy());
  await sql`PRAGMA busy_timeout = 100`.execute(other);
  const inFlight = deferred();
  const release = deferred();
  delayRingotel(called => {
    if (called !== method) {
      return null;
    }
    inFlight.resolve();
    return release.promise;
  });
  const running = operation();
  await inFlight.promise;
  const outcome = await other
    .updateTable('users')
    .set({ name: 'Elsewhere' })
    .where('id', '=', 'owner')
    .execute()
    .then(
      () => 'written',
      (error: unknown) => (error as { code?: string }).code
    );
  release.resolve();
  await running;
  return outcome;
}

describe('devices.setBlf', () => {
  it('leaves the file writable to another connection while Ringotel answers', async () => {
    const stack = await fileDb();
    const { deviceId } = await ringotelDevice(stack.db);

    const outcome = await otherWriteWhileRingotelAnswers(
      stack.file,
      'updateUser',
      () =>
        runOperation(
          stack.db,
          'devices.setBlf',
          { id: deviceId, keys: ['998'] },
          owner
        )
    );

    expect(outcome).toBe('written');
  });
});
