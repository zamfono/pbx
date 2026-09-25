import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { newId } from '@zamfono/shared';

import { mohClassDir } from './mohLayout.js';
import type { AudioKind, AudioUpload, StoredAudio } from './types.js';
import { masterExtensionFor } from './uploadTypes.js';

const execFileAsync = promisify(execFile);

// §11.6 "Audio formats": playback WAV for Asterisk. Asterisk reads a WAV by its extension, `.wav`
// as 8 kHz and `.wav16` as 16 kHz, and refuses a 16 kHz file named `.wav` ("Unable to open format
// wav"), so the wideband playback file carries `.wav16`.
const PLAYBACK_SAMPLE_RATE_HZ = 16_000;
const PLAYBACK_CHANNELS = 1;
const PLAYBACK_EXTENSION = '.wav16';

/** The shared media volume root (`MEDIA_DIR`, `images/api/Dockerfile`), read at call time so tests can override it. */
function mediaDirFromEnv(): string {
  return process.env.MEDIA_DIR ?? '/media';
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

/** Transcodes `src` to 16-bit signed linear WAV at `dest` for Asterisk playback (§11.6). */
async function transcodeToPlaybackWav(
  src: string,
  dest: string
): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    src,
    '-ar',
    String(PLAYBACK_SAMPLE_RATE_HZ),
    '-ac',
    String(PLAYBACK_CHANNELS),
    '-c:a',
    'pcm_s16le',
    // ffmpeg picks the container by the extension, which it does not know as `.wav16`.
    '-f',
    'wav',
    dest
  ]);
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
  mediaDir: string = mediaDirFromEnv()
): Promise<StoredAudio> {
  const extension = masterExtension(upload);
  const id = newId();
  const promptsDir = path.join(mediaDir, 'prompts');
  const masterPath = path.join(promptsDir, `${id}.master${extension}`);
  const wavFilename = `${id}${PLAYBACK_EXTENSION}`;
  const wavPath = path.join(promptsDir, wavFilename);
  await mkdir(promptsDir, { recursive: true });
  try {
    await writeFile(masterPath, upload.data);
    await transcodeToPlaybackWav(masterPath, wavPath);
  } catch (error) {
    await rm(masterPath, { force: true });
    await rm(wavPath, { force: true });
    throw error;
  }
  if (kind === 'moh') {
    const classDir = mohClassDir(mediaDir, id);
    await mkdir(classDir, { recursive: true });
    await copyFile(wavPath, path.join(classDir, wavFilename));
  }
  return { id, filename: wavFilename };
}

/**
 * Removes a stored audio file's playback WAV, master and (for `moh`) per-class directory from
 * the media volume; called by the daily purge job once an asset's undo window has passed.
 */
export async function deleteAudioFile(
  filename: string,
  mediaDir: string = mediaDirFromEnv()
): Promise<void> {
  const id = path.basename(filename, path.extname(filename));
  const promptsDir = path.join(mediaDir, 'prompts');
  const entries = await readdir(promptsDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter(entry => entry === filename || entry.startsWith(`${id}.master`))
      .map(entry => rm(path.join(promptsDir, entry), { force: true }))
  );
  await rm(mohClassDir(mediaDir, id), { recursive: true, force: true });
}
