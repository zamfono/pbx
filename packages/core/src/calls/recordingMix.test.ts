import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ffmpegMix } from './recordingMix.js';

const SAMPLE_RATE_HZ = 8000;
const WIDEBAND_RATE_HZ = 16_000;
const LEFT_CHANNEL = 0;
const RIGHT_CHANNEL = 1;
const SILENCE_FLOOR_DB = -60;
const AUDIBLE_FLOOR_DB = -40;
const DURATION_PRECISION_S = 1;

/** A raw per-leg recording as Asterisk's snoop channel would write it: a `duration`-second tone
 * at `frequencyHz`. */
function makeToneWav(
  filePath: string,
  frequencyHz: number,
  durationS: number,
  sampleRateHz = SAMPLE_RATE_HZ
): void {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${String(frequencyHz)}:duration=${String(durationS)}`,
    '-ar',
    String(sampleRateHz),
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    // By the content, not the extension, which ffmpeg does not know as Asterisk's `.wav16`.
    '-f',
    'wav',
    filePath
  ]);
}

/** A raw per-leg recording that captured no audio: the ~78-byte header-only wav Asterisk writes
 * when a snoop channel's recording is stopped before it ever received a sample. */
function makeHeaderOnlyWav(filePath: string): void {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    's16le',
    '-ar',
    String(SAMPLE_RATE_HZ),
    '-ac',
    '1',
    '-i',
    '/dev/null',
    '-c:a',
    'pcm_s16le',
    filePath
  ]);
}

/** The duration ffprobe reports for `filePath`, in seconds, or 0 for a header-only file. */
function probeDurationS(filePath: string): number {
  const stdout = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ]).toString();
  const durationS = Number.parseFloat(stdout.trim());
  return Number.isFinite(durationS) ? durationS : 0;
}

/** The sample rate and channel count of `filePath`'s audio stream. */
function probeStream(filePath: string): { rateHz: number; channels: number } {
  const stdout = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=sample_rate,channels',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ]).toString();
  const [rateHz, channels] = stdout.trim().split('\n').map(Number);
  if (rateHz === undefined || channels === undefined) {
    throw new Error(`probeStream: unexpected ffprobe output: ${stdout}`);
  }
  return { rateHz, channels };
}

/** The mean volume, in dB, of `channel` (0 left, 1 right) in `filePath` between `startS` and
 * `endS`: high (near 0 dB) for a channel carrying its tone, near digital silence (well below
 * `SILENCE_FLOOR_DB`) for one that is only `apad`'s padding. */
function channelMeanVolumeDb(
  filePath: string,
  channel: number,
  startS: number,
  endS: number
): number {
  // `volumedetect` reports on stderr, not stdout, so this reads `spawnSync`'s own captured
  // stream rather than `execFileSync`'s return value, which is stdout only.
  const { stderr } = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'info',
    '-i',
    filePath,
    '-filter_complex',
    `[0:a]atrim=${String(startS)}:${String(endS)},pan=mono|c0=c${String(channel)},volumedetect[v]`,
    '-map',
    '[v]',
    '-f',
    'null',
    '-'
  ]);
  const match = /mean_volume:\s*(?<db>-?[\d.]+) dB/u.exec(stderr.toString());
  if (match?.groups?.db === undefined) {
    throw new Error(`volumedetect produced no mean_volume for ${filePath}`);
  }
  return Number.parseFloat(match.groups.db);
}

describe('ffmpegMix', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeAll before each test runs
  let dir: string;
  // eslint-disable-next-line init-declarations -- see above
  let leftPath: string;
  // eslint-disable-next-line init-declarations -- see above
  let rightPath: string;
  // eslint-disable-next-line init-declarations -- see above
  let headerOnlyPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'zamfono-recording-mix-'));
    leftPath = path.join(dir, 'left.wav');
    rightPath = path.join(dir, 'right.wav');
    headerOnlyPath = path.join(dir, 'header-only.wav');
    makeToneWav(leftPath, 440, 3);
    makeToneWav(rightPath, 880, 1);
    makeHeaderOnlyWav(headerOnlyPath);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('spans the longer input and keeps the left/right mapping (§10.2 "Channels and stereo mapping")', async () => {
    const outPath = path.join(dir, 'out-both-audible.wav');

    await ffmpegMix(leftPath, rightPath, outPath);

    expect(probeDurationS(outPath)).toBeCloseTo(3, DURATION_PRECISION_S);
    // The left (recorded user) channel carries its tone for the full, longer duration.
    expect(
      channelMeanVolumeDb(outPath, LEFT_CHANNEL, 1.2, 2.8)
    ).toBeGreaterThan(AUDIBLE_FLOOR_DB);
    // The right (heard) channel's own audio ended at 1 s; past that it is `apad` silence, not a
    // truncated file.
    expect(channelMeanVolumeDb(outPath, RIGHT_CHANNEL, 1.2, 2.8)).toBeLessThan(
      SILENCE_FLOOR_DB
    );
  });

  it('pads a header-only right channel to the left channel’s own duration', async () => {
    const outPath = path.join(dir, 'out-right-header-only.wav');

    await ffmpegMix(leftPath, headerOnlyPath, outPath);

    // `amerge` alone would stop at the shorter (header-only, 0 s) input, leaving the output
    // header-only itself; padded, it spans the left channel's 3 s.
    expect(probeDurationS(outPath)).toBeCloseTo(3, DURATION_PRECISION_S);
    expect(
      channelMeanVolumeDb(outPath, LEFT_CHANNEL, 1.2, 2.8)
    ).toBeGreaterThan(AUDIBLE_FLOOR_DB);
    expect(channelMeanVolumeDb(outPath, RIGHT_CHANNEL, 0, 2.8)).toBeLessThan(
      SILENCE_FLOOR_DB
    );
  });

  it('rejects rather than writing an unplayable mix when both raw channels are header-only', async () => {
    const outPath = path.join(dir, 'out-both-header-only.wav');

    // Resolving here would leave a ~78-byte header-only `outPath`: exactly the file §10.2
    // "A `recordings` row asserts that a playable file exists" forbids a row for.
    await expect(
      ffmpegMix(headerOnlyPath, headerOnlyPath, outPath)
    ).rejects.toThrow();
  });

  it('keeps a 16 kHz pair at 16 kHz: a stereo file spanning the longer channel (§10.2 "Sample rate")', async () => {
    // Asterisk's `wav16` raw files, named as it names them.
    const wideLeft = path.join(dir, 'wide-l.wav16');
    const wideRight = path.join(dir, 'wide-r.wav16');
    makeToneWav(wideLeft, 440, 2, WIDEBAND_RATE_HZ);
    makeToneWav(wideRight, 880, 3, WIDEBAND_RATE_HZ);
    const outPath = path.join(dir, 'out-wideband.wav');

    const mixedS = await ffmpegMix(wideLeft, wideRight, outPath);

    expect(probeStream(outPath)).toEqual({
      rateHz: WIDEBAND_RATE_HZ,
      channels: 2
    });
    expect(probeDurationS(outPath)).toBeCloseTo(3, DURATION_PRECISION_S);
    // The length it reports, `recordings.duration_s`, is the file's own 3 s, not twice that.
    expect(mixedS).toBeCloseTo(3, DURATION_PRECISION_S);
  });
});
