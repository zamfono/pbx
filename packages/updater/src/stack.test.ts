import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { stackVersion } from './stack.js';

async function stackDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-stack-'));
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
