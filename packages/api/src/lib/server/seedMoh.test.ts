import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it, onTestFinished } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import {
  createMohAssets,
  MOH_NARROWBAND_EXT,
  MOH_TRACK_BASENAMES,
  MOH_WIDEBAND_EXT
} from './seedMoh.js';

const logger = pino({ level: 'silent' });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A source directory holding both variants of each bundled track. */
async function mohSourceFixture(): Promise<string> {
  const dir = await tempDir('zamfono-moh-src-');
  await Promise.all(
    MOH_TRACK_BASENAMES.flatMap(basename =>
      [MOH_NARROWBAND_EXT, MOH_WIDEBAND_EXT].map(ext =>
        writeFile(path.join(dir, `${basename}.${ext}`), `${basename} ${ext}`)
      )
    )
  );
  return dir;
}

describe('createMohAssets', () => {
  it('seeds one row per bundled track from the source directory', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempDir('zamfono-media-');
    await createMohAssets(
      db,
      { MOH_SOURCE_DIR: await mohSourceFixture() },
      mediaDir,
      nowIso(),
      logger
    );
    const rows = await db.selectFrom('audioAssets').selectAll().execute();
    expect(rows).toHaveLength(MOH_TRACK_BASENAMES.length);
    expect(rows.every(row => row.kind === 'moh')).toBe(true);
  });

  it('fails loudly when the source directory is absent', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempDir('zamfono-media-');
    const missing = path.join(
      await tempDir('zamfono-moh-missing-'),
      'does-not-exist'
    );
    await expect(
      createMohAssets(
        db,
        { MOH_SOURCE_DIR: missing },
        mediaDir,
        nowIso(),
        logger
      )
    ).rejects.toThrow(missing);
    const rows = await db.selectFrom('audioAssets').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('fails loudly when the source directory is missing one track', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempDir('zamfono-media-');
    const sourceDir = await tempDir('zamfono-moh-partial-');
    await writeFile(
      path.join(sourceDir, `${MOH_TRACK_BASENAMES[0]}.${MOH_NARROWBAND_EXT}`),
      'one file only'
    );
    await expect(
      createMohAssets(
        db,
        { MOH_SOURCE_DIR: sourceDir },
        mediaDir,
        nowIso(),
        logger
      )
    ).rejects.toThrow(/hold-music/u);
  });
});
