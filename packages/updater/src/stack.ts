import { execFile } from 'node:child_process';
import path from 'node:path';

import { parseVersion, type Version } from './version.js';

/** `update.sh --check`'s verdict on an update to a release, which only the script decides. */
export type UpdateVerdict = 'update' | 'breaking' | 'notNewer' | 'noRelease';

/** `update.sh --check`'s exit statuses, and `--current`'s 0 and 12, as its header documents them. */
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

type ScriptResult = { status: number; stdout: string; stderr: string };

/** The environment `update.sh` runs in as the updater's run (`ZAMFONO_UPDATER=1`), plus `extra`. */
export function scriptEnv(
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ZAMFONO_UPDATER: '1',
    ...extra
  };
}

/** `update.sh <args>` in the stack directory, as the updater's run. */
async function runScript(
  stackDir: string,
  args: readonly string[]
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      [path.join(stackDir, 'update.sh'), ...args],
      {
        cwd: stackDir,
        env: scriptEnv()
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(
            new Error(`update.sh ${args.join(' ')} did not run`, {
              cause: error
            })
          );
          return;
        }
        resolve({
          status: error === null ? CHECK_UPDATE : Number(error.code),
          stdout,
          stderr
        });
      }
    );
  });
}

function scriptFailed(args: readonly string[], result: ScriptResult): Error {
  return new Error(
    `update.sh ${args.join(' ')} exited ${String(result.status)}: ${result.stderr.trim()}`
  );
}

/**
 * The release the stack directory runs, as `update.sh --current` prints it, the one reading of
 * it; `undefined` for a directory that names none, a checkout of `main` among them.
 */
export async function stackVersion(
  stackDir: string
): Promise<Version | undefined> {
  const args = ['--current'];
  const result = await runScript(stackDir, args);
  if (result.status === CHECK_NO_RELEASE) {
    return undefined;
  }
  const version =
    result.status === CHECK_UPDATE
      ? parseVersion(result.stdout.trim())
      : undefined;
  if (version === undefined) {
    throw scriptFailed(args, result);
  }
  return version;
}

/**
 * What `update.sh --check <version>` in the stack directory says of an update to `version`:
 * RELEASING.md's policy lives in that script alone. Any exit status but its four verdicts is an
 * error, with the script's own message.
 */
export async function checkUpdate(
  stackDir: string,
  version: string
): Promise<UpdateVerdict> {
  const args = ['--check', version];
  const result = await runScript(stackDir, args);
  const verdict = VERDICTS.get(result.status);
  if (verdict === undefined) {
    throw scriptFailed(args, result);
  }
  return verdict;
}
