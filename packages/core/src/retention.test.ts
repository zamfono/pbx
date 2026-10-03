import {
  access,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { newId, type Db } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { runRetention } from './retention.js';
import { noopLogger } from './testing/pipelineDeps.js';
import { seedSettings } from './testing/seedRows.js';

const NOW = '2026-06-01T00:00:00.000Z';
const LONG_AGO = '2026-01-01T00:00:00.000Z';
const YESTERDAY = '2026-05-31T00:00:00.000Z';

/** One call with its log, a QoS row, a recording and a presence entry, all stamped `at`. */
async function seedCall(db: Db, at: string, filename: string): Promise<string> {
  const callId = newId();
  await db
    .insertInto('calls')
    .values({
      id: callId,
      direction: 'inbound',
      fromUri: '+15559999',
      toUri: '+15551234',
      status: 'answered',
      startedAt: at,
      log: '{"event":"answered"}'
    })
    .execute();
  await db
    .insertInto('callQos')
    .values({
      callId,
      channelId: 'ch-1',
      role: 'caller',
      jitterMs: 1,
      lossPct: 0,
      rttMs: 10
    })
    .execute();
  await db
    .insertInto('recordings')
    .values({
      id: newId(),
      callId,
      userId: null,
      filename,
      durationS: 5,
      createdAt: at
    })
    .execute();
  return callId;
}

describe('runRetention', () => {
  let db: Db;
  let mediaDir: string;

  beforeEach(async () => {
    db = await migratedTestDb();
    await seedSettings(db, { recordingRetentionDays: 90 });
    mediaDir = await mkdtemp(path.join(tmpdir(), 'zamfono-retention-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
  });

  it('removes recordings past retention, with their files, and keeps recent ones', async () => {
    const recordingsDir = path.join(mediaDir, 'recordings');
    await mkdir(recordingsDir, { recursive: true });
    await writeFile(path.join(recordingsDir, 'old.wav'), 'x');
    await writeFile(path.join(recordingsDir, 'new.wav'), 'x');
    await seedCall(db, LONG_AGO, 'old.wav');
    await seedCall(db, YESTERDAY, 'new.wav');

    const result = await runRetention({
      db,
      mediaDir,
      log: noopLogger,
      now: () => NOW
    });

    expect(result.recordings).toBe(1);
    const left = await db.selectFrom('recordings').select('filename').execute();
    expect(left.map(row => row.filename)).toEqual(['new.wav']);
    await expect(access(path.join(recordingsDir, 'old.wav'))).rejects.toThrow();
    await expect(
      access(path.join(recordingsDir, 'new.wav'))
    ).resolves.toBeUndefined();
  });

  it("removes a stale recording's raw pair and a failed mix's raw files past retention (§10.2, §11.6)", async () => {
    const recordingsDir = path.join(mediaDir, 'recordings');
    await mkdir(recordingsDir, { recursive: true });
    const write = async (name: string, at: string): Promise<string> => {
      const file = path.join(recordingsDir, name);
      await writeFile(file, 'x');
      await utimes(file, new Date(at), new Date(at));
      return file;
    };
    await seedCall(db, LONG_AGO, 'old.wav');
    await write('old.wav', LONG_AGO);
    // Left behind for a recording whose row is past retention, though touched since.
    const oldRaw = await write('old-l.wav', YESTERDAY);
    // A 16 kHz recording's raw file is `.wav16` (§10.2 "Sample rate").
    const oldRaw16 = await write('old-r.wav16', YESTERDAY);
    // A failed mix's pair, which no row names: one past retention, one recent.
    const failedOld = await write('failed-l.wav', LONG_AGO);
    const failedOldRight = await write('failed-r.wav', LONG_AGO);
    const failedOld16 = await write('wide-l.wav16', LONG_AGO);
    const failedRecent = await write('recent-l.wav', YESTERDAY);
    const unrelated = await write('mixed.wav', LONG_AGO);

    const result = await runRetention({
      db,
      mediaDir,
      log: noopLogger,
      now: () => NOW
    });

    expect(result.rawFiles).toBe(3);
    for (const gone of [
      oldRaw,
      oldRaw16,
      failedOld,
      failedOldRight,
      failedOld16
    ]) {
      // eslint-disable-next-line no-await-in-loop -- a handful of files, checked one at a time
      await expect(access(gone)).rejects.toThrow();
    }
    await expect(access(failedRecent)).resolves.toBeUndefined();
    // Only raw per-leg files are swept by age; a mixed file goes with its row.
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it('clears the diagnostics payload past retention but keeps the call history row (§7, §11.6)', async () => {
    const oldCall = await seedCall(db, LONG_AGO, 'a.wav');
    const recentCall = await seedCall(db, YESTERDAY, 'b.wav');

    const result = await runRetention({
      db,
      mediaDir,
      log: noopLogger,
      now: () => NOW
    });

    expect(result.callLogs).toBe(1);
    expect(result.callQos).toBe(1);
    const rows = await db
      .selectFrom('calls')
      .select(['id', 'log'])
      .orderBy('startedAt')
      .execute();
    // The call itself is history and stays; only its log content goes.
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === oldCall)?.log).toBeNull();
    expect(rows.find(row => row.id === recentCall)?.log).not.toBeNull();
  });

  it('removes presence_log rows past retention', async () => {
    const userId = newId();
    await db
      .insertInto('users')
      .values({
        id: userId,
        name: 'A',
        email: `${userId}@x.test`,
        createdAt: LONG_AGO
      })
      .execute();
    await db
      .insertInto('presenceLog')
      .values(
        [LONG_AGO, YESTERDAY].map(since => ({
          id: newId(),
          userId,
          status: 'available',
          since
        }))
      )
      .execute();

    const result = await runRetention({
      db,
      mediaDir,
      log: noopLogger,
      now: () => NOW
    });

    expect(result.presenceLog).toBe(1);
    const left = await db.selectFrom('presenceLog').select('since').execute();
    expect(left.map(row => row.since)).toEqual([YESTERDAY]);
  });
});
