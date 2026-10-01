import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseVersion, type Version } from './version.js';

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

/** `update.sh --check`'s verdict on an update to a release, which only the script decides. */
export type UpdateVerdict = 'update' | 'breaking' | 'notNewer' | 'noRelease';

/** `update.sh --check`'s exit statuses, as its header documents them. */
const CHECK_UPDATE = 0;
const CHECK_BREAKING = 10;
const CHECK_NOT_NEWER = 11;
const CHECK_NO_RELEASE = 12;
const VERDICTS = new Map<number, UpdateVerdict>([
  [CHECK_UPDATE, 'update'],
  [CHECK_BREAKING, 'breaking'],
  [CHECK_NOT_NEWER, 'notNewer'],
  [CHECK_NO_RELEASE, 'noRelease']
]);

/**
 * What `update.sh --check <version>` in the stack directory says of an update to `version`, as
 * the updater's run (`ZAMFONO_UPDATER=1`): RELEASING.md's policy lives in that script alone. Any
 * exit status but its four verdicts is an error, with the script's own message.
 */
export async function checkUpdate(
  stackDir: string,
  version: string
): Promise<UpdateVerdict> {
  const { status, stderr } = await new Promise<{
    status: number;
    stderr: string;
  }>((resolve, reject) => {
    execFile(
      'bash',
      [path.join(stackDir, 'update.sh'), '--check', version],
      {
        cwd: stackDir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ZAMFONO_UPDATER: '1'
        }
      },
      (error, _stdout, errorOutput) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(
            new Error(`update.sh --check ${version} did not run`, {
              cause: error
            })
          );
          return;
        }
        resolve({
          status: error === null ? CHECK_UPDATE : Number(error.code),
          stderr: errorOutput
        });
      }
    );
  });
  const verdict = VERDICTS.get(status);
  if (verdict === undefined) {
    throw new Error(
      `update.sh --check ${version} exited ${String(status)}: ${stderr.trim()}`
    );
  }
  return verdict;
}
