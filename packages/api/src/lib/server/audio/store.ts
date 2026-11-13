import { execFile, type ExecException } from 'node:child_process';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as env from '$app/env/private';

import {
  deletePromptFiles,
  HTTP_UNPROCESSABLE_CONTENT,
  newId,
  PROMPTS_SUBDIR,
  type AudioKind
} from '@zamfono/shared';

import { OpError } from '../ops/types.js';
import { mohClassDir } from './mohLayout.js';
import type { AudioUpload, StoredAudio } from './types.js';
import { masterExtensionFor } from './uploadTypes.js';

const execFileAsync = promisify(execFile);

// §11.6 "Audio formats": playback WAV for Asterisk. Asterisk reads a WAV by its extension, `.wav`
// as 8 kHz and `.wav16` as 16 kHz, and refuses a 16 kHz file named `.wav` ("Unable to open format
// wav"), so the wideband playback file carries `.wav16`.
const PLAYBACK_SAMPLE_RATE_HZ = 16_000;
const PLAYBACK_CHANNELS = 1;
const PLAYBACK_BYTES_PER_SAMPLE = 2;
const PLAYBACK_BYTES_PER_S =
  PLAYBACK_SAMPLE_RATE_HZ * PLAYBACK_CHANNELS * PLAYBACK_BYTES_PER_SAMPLE;
const PLAYBACK_EXTENSION = '.wav16';
// §10.2 "Greetings and audio": an upload's audio is at most one hour. ffmpeg stops a second past
// it (`-t`), so a longer upload shows as more than an hour of output and is refused; `-fs` holds
// the output to that second's size should `-t` not bind. The header allowance is generous for
// ffmpeg's WAV header (78 bytes on 7.1); its slack is a few milliseconds of audio.
const MAX_AUDIO_S = 3600;
const TRANSCODE_LIMIT_S = MAX_AUDIO_S + 1;
const WAV_HEADER_ALLOWANCE_BYTES = 1024;
const MAX_PLAYBACK_BYTES =
  MAX_AUDIO_S * PLAYBACK_BYTES_PER_S + WAV_HEADER_ALLOWANCE_BYTES;
const OUTPUT_LIMIT_BYTES =
  TRANSCODE_LIMIT_S * PLAYBACK_BYTES_PER_S + WAV_HEADER_ALLOWANCE_BYTES;
// An hour of audio decodes in seconds; ffmpeg still working after this long is on a malformed
// file, and is killed.
const TRANSCODE_TIMEOUT_MS = 120_000;
// ffmpeg is CPU-bound: at most one run per CPU, the uploads beyond them wait their turn (§10.2).
const TRANSCODE_SLOTS = availableParallelism();

let transcodesRunning = 0;
const waitingForSlot: (() => void)[] = [];

/**
 * Runs `task` in one of the `TRANSCODE_SLOTS` ffmpeg slots, once one is free; callers beyond them
 * wait in arrival order. A finished task hands its slot straight to the next one waiting.
 */
export async function inTranscodeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (transcodesRunning < TRANSCODE_SLOTS) {
    transcodesRunning += 1;
  } else {
    await new Promise<void>(resolve => {
      waitingForSlot.push(resolve);
    });
  }
  try {
    return await task();
  } finally {
    const next = waitingForSlot.shift();
    if (next === undefined) {
      transcodesRunning -= 1;
    } else {
      next();
    }
  }
}

/** The master file's extension, or a rejection for a type §10.2 does not accept. */
function masterExtension(upload: AudioUpload): string {
  const extension = masterExtensionFor(upload.mimeType);
  if (extension === undefined) {
    throw new Error(
      `storeAudio: unsupported upload type "${upload.mimeType}" (only WAV and MP3 are accepted)`
    );
  }
  return extension;
}

/**
 * Transcodes `src`, read only as the demuxer `inputFormat` names (`mp3` or `wav`, the declared
 * type), to 16-bit signed linear WAV at `dest` for Asterisk playback (§11.6), cut off a second past
 * the one-hour limit. A file ffmpeg cannot read as that format is refused with 422; one it is
 * still on at the timeout fails as it did before.
 */
async function transcodeToPlaybackWav(
  src: string,
  inputFormat: string,
  dest: string
): Promise<void> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        // The declared type's demuxer alone: no probing, so no FLAC, ffconcat script or any other
        // format passes under a WAV or MP3 type.
        '-f',
        inputFormat,
        '-i',
        src,
        '-t',
        String(TRANSCODE_LIMIT_S),
        '-ar',
        String(PLAYBACK_SAMPLE_RATE_HZ),
        '-ac',
        String(PLAYBACK_CHANNELS),
        '-c:a',
        'pcm_s16le',
        '-fs',
        String(OUTPUT_LIMIT_BYTES),
        // ffmpeg picks the container by the extension, which it does not know as `.wav16`.
        '-f',
        'wav',
        dest
      ],
      { timeout: TRANSCODE_TIMEOUT_MS }
    );
  } catch (error) {
    const failure = error as ExecException;
    if (typeof failure.code === 'number' && failure.killed !== true) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `upload: not a readable ${inputFormat.toUpperCase()} file`
      );
    }
    throw error;
  }
  if ((await stat(dest)).size > MAX_PLAYBACK_BYTES) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'upload: the audio is longer than one hour'
    );
  }
}

/**
 * Stores `upload` on the media volume and transcodes it to 16-bit signed linear WAV for Asterisk
 * playback (§10.2 "Greetings and audio", §11.6 "Audio formats"). The master is kept as uploaded
 * next to the playback file under `<mediaDir>/prompts/`; for `moh`, the playback WAV is copied
 * again under `<mediaDir>/prompts/moh/<id>/`, the per-class directory `musiconhold.conf` names
 * (§10.2 "Hold music", `mohLayout.ts`).
 */
export async function storeAudio(
  kind: AudioKind,
  upload: AudioUpload,
  mediaDir: string = env.MEDIA_DIR
): Promise<StoredAudio> {
  const extension = masterExtension(upload);
  const id = newId();
  const promptsDir = path.join(mediaDir, PROMPTS_SUBDIR);
  const masterPath = path.join(promptsDir, `${id}.master${extension}`);
  const wavFilename = `${id}${PLAYBACK_EXTENSION}`;
  const wavPath = path.join(promptsDir, wavFilename);
  await mkdir(promptsDir, { recursive: true });
  await inTranscodeSlot(async () => {
    try {
      await writeFile(masterPath, upload.data);
      // The extension is the demuxer's name: `.mp3` → `mp3`, `.wav` → `wav`.
      await transcodeToPlaybackWav(masterPath, extension.slice(1), wavPath);
    } catch (error) {
      await rm(masterPath, { force: true });
      await rm(wavPath, { force: true });
      throw error;
    }
  });
  if (kind === 'moh') {
    const classDir = mohClassDir(mediaDir, id);
    await mkdir(classDir, { recursive: true });
    await copyFile(wavPath, path.join(classDir, wavFilename));
  }
  return { id, filename: wavFilename };
}

/**
 * Removes a stored audio file's playback WAV, master and (for `moh`) per-class directory from
 * the media volume; called by the daily purge job once an asset's undo window has passed, and
 * once a replaced or removed mailbox greeting's row is deleted (`retireGreeting`).
 */
export async function deleteAudioFile(
  filename: string,
  mediaDir: string = env.MEDIA_DIR
): Promise<void> {
  const id = path.basename(filename, path.extname(filename));
  await deletePromptFiles(mediaDir, id);
  await rm(mohClassDir(mediaDir, id), { recursive: true, force: true });
}
