import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteAudioFile, storeAudio } from './store.js';

const WAV_CHANNELS_OFFSET = 22;
const WAV_SAMPLE_RATE_OFFSET = 24;
const WAV_BITS_PER_SAMPLE_OFFSET = 34;
const EXPECTED_SAMPLE_RATE_HZ = 16_000;
const EXPECTED_BITS_PER_SAMPLE = 16;

/** Reads a WAV file's channel count, sample rate and bit depth from its `fmt ` header. */
async function readWavFormat(
  wavPath: string
): Promise<{ channels: number; sampleRateHz: number; bitsPerSample: number }> {
  const bytes = await readFile(wavPath);
  return {
    channels: bytes.readUInt16LE(WAV_CHANNELS_OFFSET),
    sampleRateHz: bytes.readUInt32LE(WAV_SAMPLE_RATE_OFFSET),
    bitsPerSample: bytes.readUInt16LE(WAV_BITS_PER_SAMPLE_OFFSET)
  };
}

describe('storeAudio', () => {
  let mediaDir: string;
  let sineMp3: Buffer;

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), 'zamfono-audio-'));
    const sinePath = path.join(mediaDir, 'sine.mp3');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:a',
      'libmp3lame',
      sinePath
    ]);
    sineMp3 = await readFile(sinePath);
  });

  afterAll(() => rm(mediaDir, { recursive: true, force: true }));

  it('transcodes an uploaded MP3 to a 16 kHz mono 16-bit WAV', async () => {
    const stored = await storeAudio(
      'greeting',
      { filename: 'greeting.mp3', mimeType: 'audio/mpeg', data: sineMp3 },
      mediaDir
    );
    // Asterisk opens a 16 kHz WAV only under `.wav16` (§11.6 "Audio formats").
    expect(stored.filename).toBe(`${stored.id}.wav16`);
    const wavPath = path.join(mediaDir, 'prompts', stored.filename);
    const format = await readWavFormat(wavPath);
    expect(format).toEqual({
      channels: 1,
      sampleRateHz: EXPECTED_SAMPLE_RATE_HZ,
      bitsPerSample: EXPECTED_BITS_PER_SAMPLE
    });
    const masterPath = path.join(
      mediaDir,
      'prompts',
      `${stored.id}.master.mp3`
    );
    await expect(stat(masterPath)).resolves.toBeDefined();
  });

  it('also lays the WAV under its MoH class directory, inside media/prompts/, for kind moh', async () => {
    const stored = await storeAudio(
      'moh',
      { filename: 'hold.mp3', mimeType: 'audio/mpeg', data: sineMp3 },
      mediaDir
    );
    const classFile = path.join(
      mediaDir,
      'prompts',
      'moh',
      stored.id,
      stored.filename
    );
    await expect(stat(classFile)).resolves.toBeDefined();
    // §11.6 names prompts/, voicemail/ and recordings/ alone; hold music is in prompts/.
    await expect(stat(path.join(mediaDir, 'moh'))).rejects.toThrow();
  });

  it('rejects an upload type that is neither WAV nor MP3', async () => {
    await expect(
      storeAudio(
        'greeting',
        { filename: 'clip.ogg', mimeType: 'audio/ogg', data: Buffer.from('x') },
        mediaDir
      )
    ).rejects.toThrow(/unsupported upload type/u);
  });

  it('deleteAudioFile removes the WAV, master and MoH class directory', async () => {
    const stored = await storeAudio(
      'moh',
      { filename: 'track.mp3', mimeType: 'audio/mpeg', data: sineMp3 },
      mediaDir
    );
    await deleteAudioFile(stored.filename, mediaDir);
    const promptsEntries = await readdir(path.join(mediaDir, 'prompts'));
    expect(promptsEntries).not.toContain(stored.filename);
    expect(promptsEntries).not.toContain(`${stored.id}.master.mp3`);
    await expect(
      stat(path.join(mediaDir, 'prompts', 'moh', stored.id))
    ).rejects.toThrow();
  });
});
