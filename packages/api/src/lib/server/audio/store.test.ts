import { execFile, execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { mediaUsageBytes } from '@zamfono/shared';

import { deleteAudioFile, inTranscodeSlot, storeAudio } from './store.js';

// The real `execFile`, watched for the arguments and options `storeAudio` runs ffmpeg with.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

// Two CPUs, so the transcode slots are two whatever host runs the tests.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, availableParallelism: () => 2 };
});

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

// An hour and two seconds, past the one-hour limit (§10.2) and past ffmpeg's `-t` cut-off.
const OVER_AN_HOUR_S = 3602;
const UNDER_AN_HOUR_S = 3599;
const TRANSCODE_LIMIT_S = 3601;
const PLAYBACK_BYTES_PER_S = 32_000;
const WAV_HEADER_ALLOWANCE_BYTES = 1024;
// ffmpeg's ceiling on an hour's transcode, written as the test reads it.
const LONG_TEST_MS = 60_000;

/** Silence of `durationS` at 8 kHz mono, encoded by ffmpeg with `encoding` (codec and muxer
 * arguments), as the bytes of the file it wrote to `dir`. */
async function silence(
  dir: string,
  name: string,
  durationS: number,
  encoding: string[]
): Promise<Buffer> {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=8000:cl=mono',
    '-t',
    String(durationS),
    ...encoding,
    file
  ]);
  return readFile(file);
}

describe('storeAudio', () => {
  let mediaDir: string;
  let fixturesDir: string;
  let sineMp3: Buffer;

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), 'zamfono-audio-'));
    fixturesDir = await mkdtemp(path.join(tmpdir(), 'zamfono-audio-fixtures-'));
    const sinePath = path.join(fixturesDir, 'sine.mp3');
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

  afterAll(async () => {
    await rm(mediaDir, { recursive: true, force: true });
    await rm(fixturesDir, { recursive: true, force: true });
  });

  /** What `prompts/` holds: nothing at all once every upload there was refused. */
  async function promptsEntries(): Promise<string[]> {
    return readdir(path.join(mediaDir, 'prompts')).catch(() => []);
  }

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

  it('runs ffmpeg under a timeout, so an upload it never finishes on fails', async () => {
    vi.mocked(execFile).mockClear();
    await storeAudio(
      'greeting',
      { filename: 'greeting.mp3', mimeType: 'audio/mpeg', data: sineMp3 },
      mediaDir
    );
    expect(vi.mocked(execFile).mock.calls[0]?.[2]).toMatchObject({
      timeout: expect.any(Number) as unknown
    });
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

  it('reads the upload only as its declared type and caps the output at an hour and a second', async () => {
    vi.mocked(execFile).mockClear();
    await storeAudio(
      'greeting',
      { filename: 'greeting.mp3', mimeType: 'audio/mpeg', data: sineMp3 },
      mediaDir
    );
    const args = vi.mocked(execFile).mock.calls[0]?.[1] as string[];
    const input = args.indexOf('-i');
    expect(args.slice(input - 2, input)).toEqual(['-f', 'mp3']);
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual([
      '-t',
      String(TRANSCODE_LIMIT_S)
    ]);
    expect(args.indexOf('-t')).toBeGreaterThan(input);
    expect(args.slice(args.indexOf('-fs'), args.indexOf('-fs') + 2)).toEqual([
      '-fs',
      String(
        TRANSCODE_LIMIT_S * PLAYBACK_BYTES_PER_S + WAV_HEADER_ALLOWANCE_BYTES
      )
    ]);

    vi.mocked(execFile).mockClear();
    const wav = await silence(fixturesDir, 'short.wav', 1, ['-f', 'wav']);
    await storeAudio(
      'greeting',
      { filename: 'greeting.wav', mimeType: 'audio/x-wav', data: wav },
      mediaDir
    );
    const wavArgs = vi.mocked(execFile).mock.calls[0]?.[1] as string[];
    const wavInput = wavArgs.indexOf('-i');
    expect(wavArgs.slice(wavInput - 2, wavInput)).toEqual(['-f', 'wav']);
  });

  it(
    'refuses with 422 an MP3 longer than one hour, leaving no file behind',
    async () => {
      const before = await promptsEntries();
      const mp3 = await silence(fixturesDir, 'long.mp3', OVER_AN_HOUR_S, [
        '-c:a',
        'libmp3lame',
        '-b:a',
        '8k'
      ]);
      await expect(
        storeAudio(
          'greeting',
          { filename: 'long.mp3', mimeType: 'audio/mpeg', data: mp3 },
          mediaDir
        )
      ).rejects.toMatchObject({
        status: 422,
        title: 'upload: the audio is longer than one hour'
      });
      await expect(promptsEntries()).resolves.toEqual(before);
    },
    LONG_TEST_MS
  );

  it(
    'accepts an MP3 just under one hour',
    async () => {
      const mp3 = await silence(fixturesDir, 'hour.mp3', UNDER_AN_HOUR_S, [
        '-c:a',
        'libmp3lame',
        '-b:a',
        '8k'
      ]);
      const stored = await storeAudio(
        'greeting',
        { filename: 'hour.mp3', mimeType: 'audio/mpeg', data: mp3 },
        mediaDir
      );
      await deleteAudioFile(stored.filename, mediaDir);
    },
    LONG_TEST_MS
  );

  // Under `-f wav` a WAV may still carry any codec ffmpeg decodes, each inflating as much as raw
  // PCM: the output cap, not the demuxer, bounds it.
  it.each([
    ['FLAC', 'flac'],
    ['IMA ADPCM', 'adpcm_ima_wav'],
    ['GSM', 'gsm_ms'],
    ['MP3', 'libmp3lame']
  ])(
    'refuses with 422 a WAV holding over an hour of %s',
    async (_name, codec) => {
      const before = await promptsEntries();
      const wav = await silence(fixturesDir, `${codec}.wav`, OVER_AN_HOUR_S, [
        '-c:a',
        codec,
        '-f',
        'wav'
      ]);
      await expect(
        storeAudio(
          'greeting',
          { filename: 'long.wav', mimeType: 'audio/wav', data: wav },
          mediaDir
        )
      ).rejects.toMatchObject({
        status: 422,
        title: 'upload: the audio is longer than one hour'
      });
      await expect(promptsEntries()).resolves.toEqual(before);
    },
    LONG_TEST_MS
  );

  it('refuses with 422 FLAC or an ffconcat script declared as MP3, and ffconcat declared as WAV', async () => {
    const before = await promptsEntries();
    const flac = await silence(fixturesDir, 'clip.flac', 1, ['-c:a', 'flac']);
    // A script that would read another asset's playback file, were its demuxer probed.
    const concatPath = path.join(fixturesDir, 'concat.txt');
    await writeFile(
      concatPath,
      "ffconcat version 1.0\nfile 'clip.flac'\n",
      'utf8'
    );
    const ffconcat = await readFile(concatPath);
    const refusals = [
      [flac, 'audio/mpeg', 'MP3'],
      [ffconcat, 'audio/mpeg', 'MP3'],
      [ffconcat, 'audio/wav', 'WAV']
    ] as const;
    for (const [data, mimeType, type] of refusals) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against an untouched prompts/
      await expect(
        storeAudio('greeting', { filename: 'upload', mimeType, data }, mediaDir)
      ).rejects.toMatchObject({
        status: 422,
        title: `upload: not a readable ${type} file`
      });
    }
    await expect(promptsEntries()).resolves.toEqual(before);
  });

  it('runs at most availableParallelism() transcodes at once; the others wait their turn in order', async () => {
    const started: number[] = [];
    const finish: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const settled = Promise.allSettled(
      [0, 1, 2, 3, 4].map(async index =>
        inTranscodeSlot(async () => {
          started.push(index);
          running += 1;
          peak = Math.max(peak, running);
          await new Promise<void>(resolve => {
            finish.push(resolve);
          });
          running -= 1;
          if (index === 0) {
            throw new Error('a failed transcode frees its slot too');
          }
          return index;
        })
      )
    );
    await vi.waitFor(() => {
      expect(started).toEqual([0, 1]);
    });
    for (const count of [3, 4, 5]) {
      finish.shift()?.();
      // eslint-disable-next-line no-await-in-loop -- each finish lets exactly one more start
      await vi.waitFor(() => {
        expect(started).toHaveLength(count);
      });
    }
    for (const done of finish.splice(0)) {
      done();
    }
    const results = await settled;
    expect(results.map(result => result.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled'
    ]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  describe('with MEDIA_STORAGE_MAX (§11.6)', () => {
    const upload = (): {
      filename: string;
      mimeType: string;
      data: Buffer;
    } => ({
      filename: 'track.mp3',
      mimeType: 'audio/mpeg',
      data: sineMp3
    });
    let limitedDir: string;

    beforeEach(async () => {
      limitedDir = await mkdtemp(path.join(tmpdir(), 'zamfono-audio-limit-'));
      // Something already on the volume: a voicemail message of 1000 bytes.
      await mkdir(path.join(limitedDir, 'voicemail'));
      await writeFile(
        path.join(limitedDir, 'voicemail', 'm.wav'),
        Buffer.alloc(1000)
      );
    });

    afterEach(async () => {
      await rm(limitedDir, { recursive: true, force: true });
    });

    it('refuses with 507 before ffmpeg runs while the volume is at the limit', async () => {
      vi.mocked(execFile).mockClear();
      await expect(
        storeAudio(
          'greeting',
          upload(),
          limitedDir,
          await mediaUsageBytes(limitedDir)
        )
      ).rejects.toMatchObject({ status: 507 });
      expect(vi.mocked(execFile)).not.toHaveBeenCalled();
      expect(await readdir(path.join(limitedDir, 'prompts'))).toEqual([]);
    });

    it('refuses with 507 and deletes the master, WAV and MoH copy once the volume with them is over the limit', async () => {
      await expect(
        storeAudio(
          'moh',
          upload(),
          limitedDir,
          (await mediaUsageBytes(limitedDir)) + 1
        )
      ).rejects.toMatchObject({ status: 507 });
      expect(vi.mocked(execFile)).toHaveBeenCalled();
      expect(await readdir(path.join(limitedDir, 'prompts'))).toEqual(['moh']);
      expect(await readdir(path.join(limitedDir, 'prompts', 'moh'))).toEqual(
        []
      );
    });

    it('counts the space files take, not their lengths: tiny uploads reach the limit by their blocks', async () => {
      // A valid WAV of a millisecond's silence: some 60 bytes, a whole block on disk, as is its
      // playback WAV.
      const tinyPath = path.join(fixturesDir, 'tiny.wav');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=8000:cl=mono',
        '-t',
        '0.001',
        '-c:a',
        'pcm_s16le',
        tinyPath
      ]);
      const tiny = {
        filename: 'tiny.wav',
        mimeType: 'audio/wav',
        data: await readFile(tinyPath)
      };
      const emptyDir = await mkdtemp(
        path.join(tmpdir(), 'zamfono-audio-tiny-')
      );
      const limit = 8192;
      const outcomes = [];
      try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          outcomes.push(
            // eslint-disable-next-line no-await-in-loop -- one upload after the other, each checked against what the ones before it left
            await storeAudio('greeting', tiny, emptyDir, limit).then(
              () => 'stored',
              (error: unknown) => (error as { status?: number }).status
            )
          );
        }
        const promptsDir = path.join(emptyDir, 'prompts');
        const lengths = await Promise.all(
          (await readdir(promptsDir)).map(
            async name => (await stat(path.join(promptsDir, name))).size
          )
        );
        // What was stored is far below the limit by its lengths; by its blocks it reached it.
        expect(lengths.reduce((total, size) => total + size, 0)).toBeLessThan(
          limit / 4
        );
        expect(outcomes).toContain(507);
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });

    it('stores an upload that leaves the volume within the limit', async () => {
      const stored = await storeAudio(
        'greeting',
        upload(),
        limitedDir,
        1024 ** 2
      );
      await expect(
        stat(path.join(limitedDir, 'prompts', stored.filename))
      ).resolves.toBeDefined();
    });
  });

  it('deleteAudioFile removes the WAV, master and MoH class directory', async () => {
    const stored = await storeAudio(
      'moh',
      { filename: 'track.mp3', mimeType: 'audio/mpeg', data: sineMp3 },
      mediaDir
    );
    await deleteAudioFile(stored.filename, mediaDir);
    const entries = await promptsEntries();
    expect(entries).not.toContain(stored.filename);
    expect(entries).not.toContain(`${stored.id}.master.mp3`);
    await expect(
      stat(path.join(mediaDir, 'prompts', 'moh', stored.id))
    ).rejects.toThrow();
  });
});
