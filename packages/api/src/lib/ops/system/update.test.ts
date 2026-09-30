import { afterEach, describe, expect, it } from 'vitest';

import { newId, type Db } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';
import { OpError } from '../types.js';

import '../index.js';

import {
  setUpdaterClient,
  UpdaterRefusal,
  type UpdaterClient,
  type UpdateState
} from './_updater.js';

const asOwner: RunInput = {
  actor: { id: 'o1', name: 'Owner', role: 'owner' },
  channel: 'mcp',
  requestId: 'req-1',
  confirm: true
};
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const STATUS_CONFLICT = 409;
const STATUS_UNAVAILABLE = 503;

afterEach(() => {
  setUpdaterClient(undefined);
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
    await backupFinished(db, 5 * MINUTE_MS);
    const updater = recordingUpdater(() =>
      Promise.resolve({ state: 'running', from: '0.0.6', to: '0.0.7' })
    );
    setUpdaterClient(() => updater);

    expect(
      await runOperation(db, 'system.update', { version: '0.0.7' }, asOwner)
    ).toEqual({ state: 'running', from: '0.0.6', to: '0.0.7' });
    expect(updater.asked).toEqual(['0.0.7']);
  });

  it('refuses without a recent backup, and leaves the updater alone', async () => {
    const db = await makeTestDb();
    await backupFinished(db, 2 * HOUR_MS);
    const updater = recordingUpdater(() =>
      Promise.resolve({ state: 'running' })
    );
    setUpdaterClient(() => updater);

    const error = await refusal(runOperation(db, 'system.update', {}, asOwner));
    expect(error.status).toBe(STATUS_CONFLICT);
    expect(error.message).toContain('backups.runs.start');
    expect(updater.asked).toEqual([]);
  });

  it('passes on the updater’s refusal', async () => {
    const db = await makeTestDb();
    await backupFinished(db, MINUTE_MS);
    setUpdaterClient(() =>
      recordingUpdater(() =>
        Promise.reject(
          new UpdaterRefusal(
            STATUS_CONFLICT,
            '0.0.6 to 0.1.0 is a breaking update'
          )
        )
      )
    );
    const error = await refusal(
      runOperation(db, 'system.update', { version: '0.1.0' }, asOwner)
    );
    expect(error.status).toBe(STATUS_CONFLICT);
    expect(error.message).toContain('breaking');
  });

  it('is unavailable without UPDATER_TOKEN', async () => {
    const db = await makeTestDb();
    await backupFinished(db, MINUTE_MS);
    setUpdaterClient(() => undefined);
    const error = await refusal(runOperation(db, 'system.update', {}, asOwner));
    expect(error.status).toBe(STATUS_UNAVAILABLE);
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
    expect(unconfirmed.status).toBe(STATUS_CONFLICT);
  });
});
