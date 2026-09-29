import { describe, expect, it } from 'vitest';

import type { ExecFn } from './backupBackends.js';
import { ensureRepository } from './backupRestic.js';

type Call = string[];

/** An exec whose `restic cat config` fails with `catConfigCode`, recording every argv. */
function resticWithout(catConfigCode: number | undefined): {
  exec: ExecFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: ExecFn = (_file, args) => {
    calls.push([...args]);
    if (args[0] === 'cat' && catConfigCode !== undefined) {
      return Promise.reject(
        Object.assign(new Error(`restic exited ${catConfigCode}`), {
          code: catConfigCode
        })
      );
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { exec, calls };
}

const OPTIONS = ['-o', 'sftp.command=ssh'];
const NO_REPOSITORY = 10;
const WRONG_PASSWORD = 12;

describe('ensureRepository', () => {
  it('leaves an existing repository alone', async () => {
    const { exec, calls } = resticWithout(undefined);
    await ensureRepository(exec, {}, OPTIONS);
    expect(calls).toEqual([['cat', 'config', ...OPTIONS]]);
  });

  it('initializes the repository a new target does not have yet', async () => {
    const { exec, calls } = resticWithout(NO_REPOSITORY);
    await ensureRepository(exec, {}, OPTIONS);
    expect(calls).toEqual([
      ['cat', 'config', ...OPTIONS],
      ['init', ...OPTIONS]
    ]);
  });

  it('fails on a repository it cannot open, and initializes nothing over it', async () => {
    const { exec, calls } = resticWithout(WRONG_PASSWORD);
    await expect(ensureRepository(exec, {}, OPTIONS)).rejects.toThrow(
      'restic exited 12'
    );
    expect(calls).toEqual([['cat', 'config', ...OPTIONS]]);
  });
});
