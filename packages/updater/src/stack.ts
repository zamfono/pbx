import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseVersion, type Version } from './policy.js';

const ENV_PIN = /^ZAMFONO_VERSION=["']?(?<version>\d+\.\d+\.\d+)["']?$/gmu;

/** `file`'s text, or `''` when there is no such file. */
async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/**
 * The release the stack directory runs, as `update.sh`'s `current_version` reads it: the last
 * `ZAMFONO_VERSION` in `.env` that names one, the line Compose takes too, else the release the
 * bundle's `VERSION` names. `undefined` for a directory with neither, a checkout of `main` among
 * them.
 */
export async function stackVersion(
  stackDir: string
): Promise<Version | undefined> {
  const env = await readOptional(path.join(stackDir, '.env'));
  const fromEnv = [...env.matchAll(ENV_PIN)].at(-1)?.groups?.version;
  return parseVersion(
    fromEnv ?? (await readOptional(path.join(stackDir, 'VERSION'))).trim()
  );
}
