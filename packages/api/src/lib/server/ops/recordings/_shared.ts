import { rm } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';
import type { Selectable, Transaction } from 'kysely';

import {
  HTTP_NOT_FOUND,
  recordingFileNames,
  RECORDINGS_SUBDIR,
  type DB
} from '@zamfono/shared';

import { OpError } from '../types.js';

/** A `recordings` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type RecordingRow = Selectable<DB['recordings']>;

export type RecordingOut = {
  id: string;
  callId: string;
  userId: string | null;
  filename: string;
  durationS: number;
  createdAt: string;
};

export function toRecordingOut(row: RecordingRow): RecordingOut {
  return {
    id: row.id,
    callId: row.callId,
    userId: row.userId,
    filename: row.filename,
    durationS: row.durationS,
    createdAt: row.createdAt
  };
}

/** Loads a recording by id, or throws `OpError(404)`; `recordings` carries no soft delete (§11.2). */
export async function loadRecording(
  db: Transaction<DB>,
  id: string
): Promise<RecordingRow> {
  const row = await db
    .selectFrom('recordings')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(HTTP_NOT_FOUND, `recording '${id}' not found`);
  }
  return row;
}

/**
 * Removes a recording's mixed audio file from the media volume, with the raw per-leg pair
 * (`<id>-l.wav`, `<id>-r.wav`, §11.6, or `.wav16` at 16 kHz, §10.2 "Sample rate") it was mixed
 * from should any of it still be there; missing files are not an error.
 */
export async function deleteRecordingFile(
  filename: string,
  mediaDir: string = env.MEDIA_DIR
): Promise<void> {
  await Promise.all(
    recordingFileNames(filename).map(name =>
      rm(path.join(mediaDir, RECORDINGS_SUBDIR, name), { force: true })
    )
  );
}
