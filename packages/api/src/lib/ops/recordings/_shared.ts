import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { Selectable, Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import { transcodeForDownload } from '../../audio/transcode.js';
import { OpError } from '../types.js';

const STATUS_NOT_FOUND = 404;

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
    throw new OpError(STATUS_NOT_FOUND, `recording '${id}' not found`);
  }
  return row;
}

const RECORDINGS_SUBDIR = 'recordings';
// The raw pair's names beside `<id>.wav`: Asterisk's 8 kHz `.wav` or 16 kHz `.wav16`.
const RAW_SUFFIXES = ['-l.wav', '-r.wav', '-l.wav16', '-r.wav16'];

/** The shared media volume root (`MEDIA_DIR`), read at call time so tests can override it. */
function mediaDirFromEnv(): string {
  return process.env.MEDIA_DIR ?? '/media';
}

/**
 * Removes a recording's mixed audio file from the media volume, with the raw per-leg pair
 * (`<id>-l.wav`, `<id>-r.wav`, §11.6, or `.wav16` at 16 kHz, §10.2 "Sample rate") it was mixed
 * from should any of it still be there; missing files are not an error.
 */
export async function deleteRecordingFile(
  filename: string,
  mediaDir: string = mediaDirFromEnv()
): Promise<void> {
  const base = path.basename(filename, path.extname(filename));
  await Promise.all(
    [filename, ...RAW_SUFFIXES.map(suffix => `${base}${suffix}`)].map(name =>
      rm(path.join(mediaDir, RECORDINGS_SUBDIR, name), { force: true })
    )
  );
}

export type AudioBytes = {
  bytes: Buffer;
  contentType: string;
  filename: string;
};

const CONTENT_TYPE_BY_DOWNLOAD_FORMAT: Record<'opus' | 'mp3', string> = {
  opus: 'audio/ogg',
  mp3: 'audio/mpeg'
};

/**
 * A recording's mixed stereo audio (§10.3, §11.6): the stored WAV as-is with no `format`, or
 * transcoded to Opus/MP3 for download.
 */
export async function loadRecordingAudio(
  filename: string,
  format: 'opus' | 'mp3' | undefined,
  mediaDir: string = mediaDirFromEnv()
): Promise<AudioBytes> {
  const filePath = path.join(mediaDir, RECORDINGS_SUBDIR, filename);
  if (format === undefined) {
    return {
      bytes: await readFile(filePath),
      contentType: 'audio/wav',
      filename
    };
  }
  const bytes = await transcodeForDownload(filePath, format);
  const base = path.basename(filename, path.extname(filename));
  return {
    bytes,
    contentType: CONTENT_TYPE_BY_DOWNLOAD_FORMAT[format],
    filename: `${base}.${format}`
  };
}
