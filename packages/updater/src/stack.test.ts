import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { checkUpdate, stackVersion } from './stack.js';

async function stackDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-stack-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(
    Object.entries(files).map(async ([name, text]) =>
      writeFile(path.join(dir, name), text)
    )
  );
  return dir;
}

describe('stackVersion', () => {
  it('reads the bundle’s VERSION', async () => {
    const dir = await stackDir({ VERSION: '0.0.6\n', '.env': 'FQDN=x\n' });
    expect(await stackVersion(dir)).toEqual([0, 0, 6]);
  });

  it('prefers the last ZAMFONO_VERSION .env pins', async () => {
    const dir = await stackDir({
      VERSION: '0.0.6\n',
      '.env': "FQDN=x\nZAMFONO_VERSION='0.0.4'\nZAMFONO_VERSION='0.0.5'\n"
    });
    expect(await stackVersion(dir)).toEqual([0, 0, 5]);
  });

  it('knows none for a directory that pins none', async () => {
    const dir = await stackDir({ '.env': 'FQDN=x\n' });
    expect(await stackVersion(dir)).toBeUndefined();
  });

  it('fails on a .env it cannot read', async () => {
    const dir = await stackDir({ VERSION: '0.0.6\n' });
    await mkdir(path.join(dir, '.env'));
    await expect(stackVersion(dir)).rejects.toThrow(/EISDIR/u);
  });
});

/** A stand-in for update.sh that exits with `code`, after a word on stderr, when asked as --check by the updater. */
async function scriptExiting(code: number): Promise<string> {
  return stackDir({
    'update.sh': `[ "$1 $ZAMFONO_UPDATER" = '--check 1' ] || exit 99\necho 'said so' >&2\nexit ${String(code)}\n`
  });
}

describe('checkUpdate', () => {
  it.each([
    [0, 'update'],
    [10, 'breaking'],
    [11, 'notNewer'],
    [12, 'noRelease']
  ])('reads exit status %i as %s', async (code, verdict) => {
    expect(await checkUpdate(await scriptExiting(code), '0.0.7')).toBe(verdict);
  });

  it('fails on any other status, with the script’s message', async () => {
    await expect(checkUpdate(await scriptExiting(1), '0.0.7')).rejects.toThrow(
      'update.sh --check 0.0.7 exited 1: said so'
    );
  });
});
