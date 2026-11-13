/**
 * `MEDIA_STORAGE_MAX` (§6.3 "Environment", §11.6 "Media storage limit"): the most the media volume
 * may hold, which `api` checks before and after transcoding an upload and `core` before starting a
 * call recording, taking a voicemail message or recording a greeting by phone.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

// Each suffix a power of 1024 above the one before it: `K` 1024¹ … `T` 1024⁴.
const UNITS = 'KMGT';
const BYTES_PER_UNIT_STEP = 1024;
// `st_blocks` counts 512-byte units, whatever the file system's own block size.
const ST_BLOCK_BYTES = 512;

/**
 * `MEDIA_STORAGE_MAX` in bytes, `null` while unset or empty (no limit): a positive whole number of
 * bytes with an optional `K`, `M`, `G` or `T` (powers of 1024), e.g. `20G`. Throws on anything else,
 * so a malformed value fails the start of `api` and `core` rather than set no limit.
 */
export function parseMediaStorageMax(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }
  const groups = /^(?<count>\d+)(?<unit>[KMGT])?$/u.exec(value)?.groups;
  const bytes =
    groups === undefined
      ? Number.NaN
      : Number(groups.count) *
        BYTES_PER_UNIT_STEP **
          (groups.unit === undefined ? 0 : UNITS.indexOf(groups.unit) + 1);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(
      `MEDIA_STORAGE_MAX: expected a positive number of bytes with an optional K, M, G or T (e.g. 20G), or empty for no limit; got '${value}'`
    );
  }
  return bytes;
}

/** Whether `error` is a missing file's: one deleted while the walk went by it. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * The space the files under `mediaDir` take on disk, every subdirectory walked (prompts, hold
 * music, recordings, voicemail, and whatever else lies there), the subdirectories' own blocks
 * included: what is allocated, not the files' lengths, since a small file takes a whole block;
 * 0 while it does not exist. Symbolic links are not followed, and a file removed during the walk
 * counts as gone.
 */
export async function mediaUsageBytes(mediaDir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(mediaDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return 0;
    }
    throw error;
  }
  const sizes = await Promise.all(
    entries
      .filter(entry => entry.isFile() || entry.isDirectory())
      .map(entry =>
        lstat(path.join(entry.parentPath, entry.name)).then(
          stats => stats.blocks * ST_BLOCK_BYTES,
          (error: unknown) => {
            if (isMissing(error)) {
              return 0;
            }
            throw error;
          }
        )
      )
  );
  return sizes.reduce((total, size) => total + size, 0);
}
