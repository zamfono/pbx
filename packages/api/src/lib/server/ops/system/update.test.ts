import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTTP_CONFLICT,
  HTTP_SERVICE_UNAVAILABLE,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  newId,
  type Db,
  type UpdateState
} from '@zamfono/shared';

import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { OpError } from '../types.js';

import '../index.js';

import {
  updaterClient,
  UpdaterRefusal,
  type UpdaterClient
} from './_updater.js';

vi.mock('./_updater.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./_updater.js')>()),
  updaterClient: vi.fn()
}));

const asOwner: RunInput = {
  actor: { id: 'o1', name: 'Owner', role: 'owner' },
  channel: 'mcp',
  requestId: 'req-1',
  confirm: true
};

afterEach(() => {
  vi.mocked(updaterClient).mockReset();
});

/** One `ok` backup run that finished `ageMs` ago. */
async function backupFinished(db: Db, ageMs: number): Promise<void> {
  const targetId = newId();
  const finishedAt = new Date(Date.now() - ageMs).toISOString();
  await db
    .insertInto('backupTargets')
    .values({
      id: targetId,
      kind: 'local',
      paramsJson: '{"path":"/backups/restic"}',
      enabled: 1,
      secretEnc: Buffer.from('x'),
      createdAt: finishedAt
    })
    .execute();
  await db
    .insertInto('backupRuns')
    .values({
      id: newId(),
      targetId,
      status: 'ok',
      snapshotId: 'snap',
      bytesAdded: 1,
      bytesTotal: 1,
      error: null,
      startedAt: finishedAt,
      finishedAt
    })
    .execute();
}

function recordingUpdater(
  answer: () => Promise<UpdateState>
): UpdaterClient & { asked: (string | undefined)[] } {
  const asked: (string | undefined)[] = [];
  return {
    asked,
    status: () => Promise.reject(new Error('unused')),
    update: async version => {
      asked.push(version);
      return answer();
    }
  };
}

async function refusal(promise: Promise<unknown>): Promise<OpError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof OpError)) {
    throw new Error(`expected an OpError, got ${String(error)}`);
  }
  return error;
}

describe('system.update', () => {
  it('asks the updater once a backup finished within the hour, and answers at once', async () => {
    const db = await makeTestDb();
    await backupFinished(db, 5 * MS_PER_MINUTE);
    const started = {
      state: 'running' as const,
      from: '0.0.6',
      to: '0.0.7',
      startedAt: '2026-10-01T03:00:00.000Z'
    };
    const updater = recordingUpdater(() => Promise.resolve(started));
    vi.mocked(updaterClient).mockImplementation(() => updater);

    expect(
      await runOperation(db, 'system.update', { version: '0.0.7' }, asOwner)
    ).toEqual(started);
    expect(updater.asked).toEqual(['0.0.7']);
    await expect(
      db
        .selectFrom('updateState')
        .select(['runStartedAt', 'runOutcomePending'])
        .executeTakeFirst()
    ).resolves.toEqual({
      runStartedAt: started.startedAt,
      runOutcomePending: 0
    });
  });

  it('refuses without a recent backup, and leaves the updater alone', async () => {
    const db = await makeTestDb();
    await backupFinished(db, 2 * MS_PER_HOUR);
    const updater = recordingUpdater(() =>
      Promise.resolve({ state: 'running' })
    );
    vi.mocked(updaterClient).mockImplementation(() => updater);

    const error = await refusal(runOperation(db, 'system.update', {}, asOwner));
    expect(error.status).toBe(HTTP_CONFLICT);
    expect(error.message).toContain('backups.runs.start');
    expect(updater.asked).toEqual([]);
  });

  it('passes on the updater’s refusal', async () => {
    const db = await makeTestDb();
    await backupFinished(db, MS_PER_MINUTE);
    vi.mocked(updaterClient).mockImplementation(() =>
      recordingUpdater(() =>
        Promise.reject(
          new UpdaterRefusal(
            HTTP_CONFLICT,
            '0.0.6 to 0.1.0 is a breaking update'
          )
        )
      )
    );
    const error = await refusal(
      runOperation(db, 'system.update', { version: '0.1.0' }, asOwner)
    );
    expect(error.status).toBe(HTTP_CONFLICT);
    expect(error.message).toContain('breaking');
  });

  it('is unavailable without UPDATER_TOKEN', async () => {
    const db = await makeTestDb();
    await backupFinished(db, MS_PER_MINUTE);
    vi.mocked(updaterClient).mockImplementation(() => undefined);
    const error = await refusal(runOperation(db, 'system.update', {}, asOwner));
    expect(error.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(error.message).toContain('update.sh');
  });

  it('is the owner’s alone, and asks for confirmation', async () => {
    const db = await makeTestDb();
    const asAdmin: RunInput = {
      ...asOwner,
      actor: { id: 'a1', name: 'Admin', role: 'admin' }
    };
    await expect(
      runOperation(db, 'system.update', {}, asAdmin)
    ).rejects.toThrow();
    const unconfirmed = await refusal(
      runOperation(db, 'system.update', {}, { ...asOwner, confirm: false })
    );
    expect(unconfirmed.status).toBe(HTTP_CONFLICT);
  });
});
