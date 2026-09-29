import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseVersion, type Version } from './policy.js';

const PIN = /\$\{ZAMFONO_VERSION:-(?<version>\d+\.\d+\.\d+)\}/u;
const ENV_PIN = /^ZAMFONO_VERSION=["']?(?<version>\d+\.\d+\.\d+)["']?$/mu;

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The release the stack directory runs, as `update.sh`'s `current_version` reads it: `.env`'s
 * `ZAMFONO_VERSION` when it names one, else the default the release bundle pinned in
 * `compose.yaml`. `undefined` for a directory neither pins, a checkout of `main` among them.
 */
export async function stackVersion(
  stackDir: string
): Promise<Version | undefined> {
  const env = await readOptional(path.join(stackDir, '.env'));
  const fromEnv = ENV_PIN.exec(env)?.groups?.version;
  if (fromEnv !== undefined) {
    return parseVersion(fromEnv);
  }
  const compose = await readOptional(path.join(stackDir, 'compose.yaml'));
  const pinned = PIN.exec(compose)?.groups?.version;
  return pinned === undefined ? undefined : parseVersion(pinned);
}
