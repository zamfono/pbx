import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { BinaryResult } from '../binaryResult.js';

const execFileAsync = promisify(execFile);

const CONTAINER_BY_FORMAT = { opus: 'ogg', mp3: 'mp3' } as const;
const CODEC_BY_FORMAT = { opus: 'libopus', mp3: 'libmp3lame' } as const;
const CONTENT_TYPE_BY_FORMAT = {
  opus: 'audio/ogg',
  mp3: 'audio/mpeg'
} as const;

/**
 * Transcodes the audio file at `src` to a compressed download format (§11.6 "Audio formats"):
 * Opus in an Ogg container, or MP3, returned as the encoded bytes. `ffmpeg` writes to a
 * temporary file, read back afterward, so the encoded size is bounded only by disk space — a
 * call recording (§10.3 "Voicemail/Recordings audio downloads") has no duration cap.
 */
export async function transcodeForDownload(
  src: string,
  format: DownloadFormat
): Promise<Buffer> {
  const tmpPath = path.join(
    os.tmpdir(),
    `zamfono-transcode-${randomUUID()}.${CONTAINER_BY_FORMAT[format]}`
  );
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      src,
      '-f',
      CONTAINER_BY_FORMAT[format],
      '-c:a',
      CODEC_BY_FORMAT[format],
      tmpPath
    ]);
    return await readFile(tmpPath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

export type DownloadFormat = 'opus' | 'mp3';

/**
 * The audio file at `filePath` for download (§10.3, §11.6): the stored WAV as-is with no
 * `format`, or transcoded, named after the source with the format's extension.
 */
export function downloadAudio(
  filePath: string,
  format: DownloadFormat | undefined
): BinaryResult {
  if (format === undefined) {
    return new BinaryResult('audio/wav', path.basename(filePath), () =>
      readFile(filePath)
    );
  }
  const base = path.basename(filePath, path.extname(filePath));
  return new BinaryResult(
    CONTENT_TYPE_BY_FORMAT[format],
    `${base}.${format}`,
    () => transcodeForDownload(filePath, format)
  );
}

// §10.2 "Attachments": MP3 or Opus, never WAV; MP3 is the wider-compatibility choice across mail
// clients.
const VOICEMAIL_ATTACHMENT_FORMAT = 'mp3';

/**
 * The compressed attachment for a voicemail e-mail (§10.2 "Attachments"): the audio file at
 * `voicemailPath`, transcoded, named after it, with the matching content type.
 */
export function voicemailAttachment(voicemailPath: string): BinaryResult {
  return downloadAudio(voicemailPath, VOICEMAIL_ATTACHMENT_FORMAT);
}
