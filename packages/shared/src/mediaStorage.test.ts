import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mediaUsageBytes, parseMediaStorageMax } from './mediaStorage.js';

describe('parseMediaStorageMax', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['1', 1],
    ['500', 500],
    ['2K', 2048],
    ['3M', 3 * 1024 ** 2],
    ['20G', 20 * 1024 ** 3],
    ['1T', 1024 ** 4]
  ])('reads %j as %j', (value, bytes) => {
    expect(parseMediaStorageMax(value)).toBe(bytes);
  });

  it.each([
    '0',
    '0G',
    '20g',
    '20GB',
    '1.5G',
    '-1',
    ' 20G',
    'G',
    '20 G',
    '99999999999T'
  ])('refuses %j', value => {
    expect(() => parseMediaStorageMax(value)).toThrow(/^MEDIA_STORAGE_MAX: /u);
  });
});

describe('mediaUsageBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'zamfono-media-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The space `paths` take on disk, as `stat` reports their blocks. */
  async function allocated(...paths: string[]): Promise<number> {
    const sizes = await Promise.all(
      paths.map(async entry => (await lstat(path.join(dir, entry))).blocks)
    );
    return sizes.reduce((total, blocks) => total + blocks * 512, 0);
  }

  it('adds up the space every file and directory below the media directory takes, links not followed', async () => {
    await mkdir(path.join(dir, 'prompts', 'moh', 'a'), { recursive: true });
    await mkdir(path.join(dir, 'recordings'));
    await writeFile(path.join(dir, 'prompts', 'x.wav16'), Buffer.alloc(100));
    await writeFile(
      path.join(dir, 'prompts', 'moh', 'a', 'x.wav16'),
      Buffer.alloc(100)
    );
    await writeFile(path.join(dir, 'recordings', 'r.wav'), Buffer.alloc(7));
    await writeFile(path.join(dir, 'stray'), Buffer.alloc(3));
    await symlink(
      path.join(dir, 'recordings', 'r.wav'),
      path.join(dir, 'link')
    );

    const usage = await mediaUsageBytes(dir);
    expect(usage).toBe(
      await allocated(
        'prompts',
        'prompts/moh',
        'prompts/moh/a',
        'prompts/x.wav16',
        'prompts/moh/a/x.wav16',
        'recordings',
        'recordings/r.wav',
        'stray'
      )
    );
    // Four files of 210 bytes in all take a block each.
    expect(usage).toBeGreaterThanOrEqual(4 * 512);
  });

  it('is 0 for a media directory that does not exist yet', async () => {
    expect(await mediaUsageBytes(path.join(dir, 'missing'))).toBe(0);
  });
});
