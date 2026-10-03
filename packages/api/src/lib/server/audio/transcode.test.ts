import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { transcodeForDownload, voicemailAttachment } from './transcode.js';

describe('transcodeForDownload', () => {
  let wavPath: string;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-transcode-'));
    wavPath = path.join(dir, 'source.wav');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wavPath
    ]);
  });

  afterAll(() => rm(path.dirname(wavPath), { recursive: true, force: true }));

  it('transcodes to Opus bytes carrying the Ogg magic', async () => {
    const opus = await transcodeForDownload(wavPath, 'opus');
    expect(opus.subarray(0, 4).toString('ascii')).toBe('OggS');
  });

  it('transcodes to MP3 bytes carrying the ID3 magic', async () => {
    const mp3 = await transcodeForDownload(wavPath, 'mp3');
    expect(mp3.subarray(0, 3).toString('ascii')).toBe('ID3');
  });

  it('voicemailAttachment names the file after the source with an mp3 extension', async () => {
    const sourcePath = path.join(path.dirname(wavPath), 'vm-1.wav');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      wavPath,
      sourcePath
    ]);
    const attachment = voicemailAttachment(sourcePath);
    expect(attachment.filename).toBe('vm-1.mp3');
    expect(attachment.contentType).toBe('audio/mpeg');
    expect((await attachment.read()).subarray(0, 3).toString('ascii')).toBe(
      'ID3'
    );
  });
});
