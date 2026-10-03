import path from 'node:path';

/**
 * Where `api` and `core` find the stack's `db` and `media` volumes, as compose.yaml mounts them
 * (§6.3): the defaults of `DB_FILE` and `MEDIA_DIR`, which a run outside the stack sets.
 */
export const DEFAULT_DB_FILE = '/data/zamfono.sqlite3';
export const DEFAULT_MEDIA_DIR = '/media';

/** The media volume's subdirectory recordings live in (§11.6). */
export const RECORDINGS_SUBDIR = 'recordings';

// The raw pair's names beside `<id>.wav`: Asterisk's 8 kHz `.wav` or 16 kHz `.wav16`.
const RAW_SUFFIXES = ['-l.wav', '-r.wav', '-l.wav16', '-r.wav16'];

/**
 * A recording's mixed file and the raw per-leg pair it was mixed from (`<id>-l.wav`, `<id>-r.wav`,
 * §11.6, or `.wav16` at 16 kHz, §10.2 "Sample rate"), as names in `RECORDINGS_SUBDIR`.
 */
export function recordingFileNames(filename: string): string[] {
  const base = path.basename(filename, path.extname(filename));
  return [filename, ...RAW_SUFFIXES.map(suffix => `${base}${suffix}`)];
}
