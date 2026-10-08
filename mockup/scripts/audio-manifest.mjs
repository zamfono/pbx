/**
 * The demo audio's manifest, src/lib/assets/audio/manifest.json: per clip its kind, channels,
 * length and, for the audio library, the waveform the page draws. The generators update their own
 * entries and keep the others.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
export const outDir = join(root, 'src/lib/assets/audio');
const manifestFile = join(outDir, 'manifest.json');

/** Bars of the waveform the audio library draws. */
const BARS = 36;

export const probe = file =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString()
  );

/** The file's loudness in `BARS` slices, 0–1 relative to its loudest slice. */
export function peaksOf(file) {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], {
    maxBuffer: 1 << 28
  });
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const size = Math.max(1, Math.floor(samples.length / BARS));
  const levels = Array.from({ length: BARS }, (_, bar) => {
    let sum = 0;
    for (let index = bar * size; index < (bar + 1) * size && index < samples.length; index += 1) {
      sum += samples[index] * samples[index];
    }
    return Math.sqrt(sum / size);
  });
  const loudest = Math.max(...levels, 1);
  return levels.map(level => Math.round((level / loudest) * 100) / 100);
}

/** Writes `entries` into the manifest, keeping the entries of the other generators. */
export function updateManifest(entries) {
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
  Object.assign(manifest, entries);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
