// The audio side of scripts/generate-prompts.mjs (spec §9.1): mono samples in [-1, 1] at `RATE`,
// brought to one loudness, cut at quiet points, trimmed of silence and written in the formats
// Asterisk picks from by codec.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const RATE = 24000;
const LOUDNESS_LUFS = -19;
const TRUE_PEAK_DB = -1.5;
// The level below which a clip's ends count as silence, and how much of it is kept.
const SILENCE_DBFS = -45;
const SILENCE_KEEP_S = 0.02;
// The frame the level is measured over.
const FRAME_S = 0.01;
const FADE_S = 0.005;
const INT16_MAX = 32767;
const DECIBEL_BASE = 10;
const DB_PER_DECADE = 20;
/** @type {[string, string[]][]} */
const FORMATS = [
  ['wav', ['-ar', '8000', '-c:a', 'pcm_s16le']],
  ['g722', ['-ar', '16000', '-c:a', 'g722', '-f', 'g722']]
];
const RAW_IN = ['-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0'];
const FRAME = Math.round(FRAME_S * RATE);

/** @param {Float32Array} samples @returns {Buffer} */
function toPcm(samples) {
  const pcm = Int16Array.from(samples, sample =>
    Math.round(Math.max(-1, Math.min(1, sample)) * INT16_MAX)
  );
  return Buffer.from(pcm.buffer);
}

/** @param {string[]} args @param {Buffer} input @returns {string} ffmpeg's log */
function ffmpeg(args, input) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
    input
  });
  if (run.status !== 0) {
    throw new Error(`ffmpeg ${args.join(' ')}: ${run.stderr.toString()}`);
  }
  return run.stderr.toString();
}

/** @param {number} decibels @returns {number} the linear factor */
function linear(decibels) {
  return DECIBEL_BASE ** (decibels / DB_PER_DECADE);
}

/** The RMS level of the frame starting at `from`. @param {Float32Array} samples @param {number} from */
function level(samples, from) {
  const slice = samples.subarray(from, from + FRAME);
  const energy = slice.reduce((sum, sample) => sum + sample * sample, 0);
  return Math.sqrt(energy / Math.max(1, slice.length));
}

/**
 * The utterance at the target loudness, the gain capped so it stays under the peak limit.
 * @param {Float32Array} samples
 */
export function normalize(samples) {
  const log = ffmpeg(
    [...RAW_IN, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
    toPcm(samples)
  );
  const report = log.match(/\{[^{}]*\}/gu)?.at(-1);
  if (report === undefined) {
    throw new Error(`loudnorm printed no measurement: ${log}`);
  }
  // JSON.parse is necessarily `any`; loudnorm prints its measurements as strings.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { input_i: loudness, input_tp: peak } = JSON.parse(report);
  const gain = linear(
    Math.min(LOUDNESS_LUFS - Number(loudness), TRUE_PEAK_DB - Number(peak))
  );
  return samples.map(sample => sample * gain);
}

/**
 * The time of the quietest frame between two times, where a word can be cut without cutting a
 * sound: a stop's closure, the pause between words.
 * @param {Float32Array} samples @param {number} fromS @param {number} toS
 */
export function quietest(samples, fromS, toS) {
  const last = Math.min(samples.length - FRAME, Math.round(toS * RATE));
  let best = Math.max(0, Math.round(fromS * RATE));
  for (let from = best; from <= last; from += FRAME) {
    if (level(samples, from) < level(samples, best)) {
      best = from;
    }
  }
  return best / RATE;
}

/** Both ends faded over `seconds`. @param {Float32Array} samples @param {number} seconds */
export function fade(samples, seconds) {
  const length = Math.round(seconds * RATE);
  return samples.map(
    (sample, index) =>
      sample *
      Math.min(1, index / length, (samples.length - 1 - index) / length)
  );
}

/**
 * Drops the ends quieter than `SILENCE_DBFS`, keeping `SILENCE_KEEP_S` of each, and fades.
 * @param {Float32Array} samples
 */
export function trim(samples) {
  const threshold = linear(SILENCE_DBFS);
  let first = 0;
  while (first < samples.length && level(samples, first) < threshold) {
    first += FRAME;
  }
  let last = samples.length - FRAME;
  while (last > first && level(samples, last) < threshold) {
    last -= FRAME;
  }
  const keep = Math.round(SILENCE_KEEP_S * RATE);
  const kept = samples.slice(
    Math.max(0, first - keep),
    Math.min(samples.length, last + FRAME + keep)
  );
  return fade(kept, FADE_S);
}

/** Writes `<base>.wav` and `<base>.g722`. @param {string} base @param {Float32Array} samples */
export function write(base, samples) {
  mkdirSync(dirname(base), { recursive: true });
  const pcm = toPcm(samples);
  // No metadata, so the header stays the plain one Asterisk reads.
  const plain = ['-map_metadata', '-1', '-fflags', '+bitexact'];
  for (const [extension, codec] of FORMATS) {
    ffmpeg([...RAW_IN, ...plain, ...codec, '-y', `${base}.${extension}`], pcm);
  }
}
