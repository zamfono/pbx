/**
 * `core`'s daily retention sweep (§11.6 "Retention"): recordings older than
 * `settings.recording_retention_days` lose their files and their row, the raw per-leg files a
 * failed mix left behind (§10.2 "Best effort") go once they are as old, and `presence_log` rows,
 * `calls.log` content and `call_qos` rows go on the same schedule. Voicemails are not touched —
 * they are kept until their owner deletes them.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  cutoffIso,
  MS_PER_DAY,
  recordingFileNames,
  RECORDINGS_SUBDIR,
  repeat,
  type Db
} from '@zamfono/shared';

import { logFailure } from './ari/failures.js';
import type { Logger } from './ari/types.js';
import { ignoreMissing } from './fsFailures.js';

// A participation's raw pair, `<id>-l.wav` and `<id>-r.wav` (§11.6 "raw per-leg call recordings"),
// or `.wav16` for a 16 kHz recording (§10.2 "Sample rate").
const RAW_FILE = /-[lr]\.wav(?:16)?$/u;

type RetentionDeps = {
  db: Db;
  mediaDir: string;
  log: Logger;
  now: () => string;
};

type RetentionResult = {
  recordings: number;
  rawFiles: number;
  presenceLog: number;
  callQos: number;
  callLogs: number;
};

/** A recording's mixed file and the raw pair it was mixed from, whichever still exist. */
async function removeRecordingFiles(
  dir: string,
  filename: string
): Promise<void> {
  await Promise.all(
    recordingFileNames(filename).map(name =>
      rm(path.join(dir, name), { force: true })
    )
  );
}

/** Removes the raw per-leg files older than `before`: those of a failed mix, which no
 * `recordings` row names (§10.2 "A failed mix leaves the raw per-leg files"), are recordings too
 * and are purged on the same schedule. Returns how many went. */
async function removeStaleRawFiles(
  dir: string,
  before: string,
  log: Logger
): Promise<number> {
  const names =
    (await readdir(dir)
      .catch(ignoreMissing)
      .catch(logFailure(log, 'recordings directory read', { dir }))) ?? [];
  const removed = await Promise.all(
    names
      .filter(candidate => RAW_FILE.test(candidate))
      .map(async name => {
        const file = path.join(dir, name);
        const info = await stat(file)
          .catch(ignoreMissing)
          .catch(logFailure(log, 'raw recording file read', { file }));
        if (info === undefined || info.mtime.toISOString() >= before) {
          return false;
        }
        await rm(file, { force: true });
        return true;
      })
  );
  return removed.filter(Boolean).length;
}

/**
 * Runs one sweep. A recording's file is removed before its row, so a failure leaves a row pointing
 * at a file that may be gone rather than a file nothing references; the next sweep retries the row.
 */
export async function runRetention(
  deps: RetentionDeps
): Promise<RetentionResult> {
  const { db, mediaDir, now } = deps;
  const settings = await db
    .selectFrom('settings')
    .select('recordingRetentionDays')
    .executeTakeFirstOrThrow();
  const before = cutoffIso(now(), settings.recordingRetentionDays);

  const stale = await db
    .selectFrom('recordings')
    .select(['id', 'filename'])
    .where('createdAt', '<', before)
    .execute();
  const recordingsDir = path.join(mediaDir, RECORDINGS_SUBDIR);
  await Promise.all(
    stale.map(row => removeRecordingFiles(recordingsDir, row.filename))
  );
  const recordings = await db
    .deleteFrom('recordings')
    .where('createdAt', '<', before)
    .executeTakeFirst();
  const rawFiles = await removeStaleRawFiles(recordingsDir, before, deps.log);

  // Each user's latest row before the cutoff stays: it is that user's state at every instant from
  // the cutoff to their next transition, which the snapshot (§10.3 "Presence log") reads.
  const presenceLog = await db
    .deleteFrom('presenceLog')
    .where('since', '<', before)
    .where(eb =>
      eb.exists(
        eb
          .selectFrom('presenceLog as later')
          .select('later.id')
          .whereRef('later.userId', '=', 'presenceLog.userId')
          .where('later.since', '<', before)
          .where(later =>
            later(
              later.refTuple('later.since', 'later.id'),
              '>',
              later.refTuple('presenceLog.since', 'presenceLog.id')
            )
          )
      )
    )
    .executeTakeFirst();
  const callQos = await db
    .deleteFrom('callQos')
    .where(
      'callId',
      'in',
      db.selectFrom('calls').select('id').where('startedAt', '<', before)
    )
    .executeTakeFirst();
  // §7: the log is the call's own diagnostics payload; the `calls` row itself is call history and
  // stays, so the column is cleared rather than the row deleted.
  const callLogs = await db
    .updateTable('calls')
    .set({ log: null })
    .where('startedAt', '<', before)
    .where('log', 'is not', null)
    .executeTakeFirst();

  return {
    recordings: Number(recordings.numDeletedRows),
    rawFiles,
    presenceLog: Number(presenceLog.numDeletedRows),
    callQos: Number(callQos.numDeletedRows),
    callLogs: Number(callLogs.numUpdatedRows)
  };
}

/** Runs a sweep now and then once a day; `stop()` cancels the schedule. */
export function startRetention(
  deps: RetentionDeps,
  intervalMs: number = MS_PER_DAY
): { stop: () => void } {
  return repeat(
    () =>
      runRetention(deps)
        .then(result => {
          deps.log.info(result, 'retention sweep');
        })
        .catch((error: unknown) => {
          deps.log.error({ error }, 'retention sweep failed');
        }),
    intervalMs,
    { unref: true }
  );
}
