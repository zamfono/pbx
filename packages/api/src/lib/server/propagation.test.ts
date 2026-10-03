import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as privateEnv from '$app/env/private';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';

import { getCoreClient, type CoreClient } from './coreClient.js';
import { stubCoreClient } from './coreClientStub.js';
import { propagateAtBoot, propagateConfig } from './propagation.js';
import { encrypt, keyringFromEnv, type Keyring } from './secretbox.js';
import { makeTestDb, seedSettings } from './testDb.js';

const KEY_BYTE_LENGTH = 32;

// The propagation under test, not the setup file's stand-in for it.
vi.unmock('./propagation.js');

/** A fresh `SECRETBOX_KEY`, the keyring a propagation renders with. */
function testKeyring(): Keyring {
  process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;
  return keyringFromEnv(privateEnv);
}

/** Has the next propagation render into `genDir` and reach `core` through `coreClient`. */
function propagateInto(genDir: string, coreClient: CoreClient): void {
  process.env.ASTERISK_GEN_DIR = genDir;
  vi.mocked(getCoreClient).mockReturnValue(coreClient);
}

afterEach(() => {
  delete process.env.SECRETBOX_KEY;
  delete process.env.ASTERISK_GEN_DIR;
  vi.mocked(getCoreClient).mockReset();
});

/** A user with a `1xx` extension and one manual device on it. */
async function seedUserWithDevice(db: Db, kr: Keyring): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: 'u1',
      name: 'Alice',
      email: 'alice@x',
      role: 'user',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('extensions')
    .values({ ext: '101', userId: 'u1', ringGroupId: null })
    .execute();
  await db
    .insertInto('devices')
    .values({
      id: 'd1',
      userId: 'u1',
      label: 'Desk phone',
      kind: 'manual',
      transport: 'plain',
      allowedIpsJson: '["10.0.0.0/8"]',
      sipUsername: 'e101-abcde',
      sipPasswordEnc: encrypt(kr, 'a1B2c3D4e5F6g7H8i9J0k1L2'),
      createdAt: nowIso()
    })
    .execute();
}

type RecordingCore = CoreClient & { calls: unknown[][] };

/** A `core` that takes every reload, recording each. */
function recordingCore(): RecordingCore {
  const calls: unknown[][] = [];
  return {
    ...stubCoreClient({
      configChanged: kinds => {
        calls.push(['configChanged', kinds]);
        return Promise.resolve();
      }
    }),
    calls
  };
}

describe('propagateConfig', () => {
  const workDirs: { genDir?: string } = {};

  afterEach(async () => {
    const dir = workDirs.genDir;
    workDirs.genDir = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the four rendered files and calls core once with the given kinds', async () => {
    const db = await makeTestDb();
    const kr = testKeyring();
    await seedSettings(db);
    await seedUserWithDevice(db, kr);
    const genDir = await mkdtemp(path.join(tmpdir(), 'zamfono-gen-'));
    workDirs.genDir = genDir;
    const coreClient = recordingCore();

    propagateInto(genDir, coreClient);
    await propagateConfig(db, ['pjsip', 'dialplan']);

    const filenames = [
      'pjsip_users.conf',
      'pjsip_trunks.conf',
      'extensions_hints.conf',
      'musiconhold.conf'
    ];
    const contents = await Promise.all(
      filenames.map(filename => readFile(path.join(genDir, filename), 'utf8'))
    );
    for (const text of contents) {
      expect(text.length).toBeGreaterThan(0);
    }
    const usersConf = await readFile(
      path.join(genDir, 'pjsip_users.conf'),
      'utf8'
    );
    expect(usersConf).toContain('[e101-abcde]');
    expect(usersConf).toContain('password = a1B2c3D4e5F6g7H8i9J0k1L2');
    // §11.2 `calls.from_uri`: the device's calls carry its owner's extension and name, and a
    // party it holds hears the static default class while no hold music is set (§10.2).
    expect(usersConf).toContain('callerid = "Alice" <101>');
    expect(usersConf).toContain('moh_suggest = default');
    expect(coreClient.calls).toEqual([
      ['configChanged', ['pjsip', 'dialplan']]
    ]);
  });
});

describe('the hold music class (§10.2 "Hold music")', () => {
  it("is settings.hold_moh_audio_id's own class on every device endpoint", async () => {
    const db = await makeTestDb();
    const kr = testKeyring();
    await seedSettings(db);
    await seedUserWithDevice(db, kr);
    await db
      .insertInto('audioAssets')
      .values({
        id: 'moh-1',
        kind: 'moh',
        label: 'Hold',
        filename: 'moh-1.wav',
        createdAt: nowIso()
      })
      .execute();
    await db.updateTable('settings').set({ holdMohAudioId: 'moh-1' }).execute();
    const genDir = await mkdtemp(path.join(tmpdir(), 'zamfono-gen-'));
    try {
      propagateInto(genDir, recordingCore());
      await propagateConfig(db, ['pjsip', 'moh']);
      const usersConf = await readFile(
        path.join(genDir, 'pjsip_users.conf'),
        'utf8'
      );
      expect(usersConf).toContain('moh_suggest = moh-1');
      const mohConf = await readFile(
        path.join(genDir, 'musiconhold.conf'),
        'utf8'
      );
      expect(mohConf).toContain('[moh-1]');
    } finally {
      await rm(genDir, { recursive: true, force: true });
    }
  });
});

describe('propagateAtBoot', () => {
  const workDirs: { genDir?: string } = {};

  afterEach(async () => {
    const dir = workDirs.genDir;
    workDirs.genDir = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renders every file and asks core to reload every module', async () => {
    const db = await makeTestDb();
    const kr = testKeyring();
    await seedSettings(db);
    await seedUserWithDevice(db, kr);
    const genDir = await mkdtemp(path.join(tmpdir(), 'zamfono-gen-'));
    workDirs.genDir = genDir;
    const coreClient = recordingCore();

    propagateInto(genDir, coreClient);
    await propagateAtBoot(db, pino({ level: 'silent' }));

    const hints = await readFile(
      path.join(genDir, 'extensions_hints.conf'),
      'utf8'
    );
    expect(hints).toContain('exten => 101,hint,Stasis:presence-101');
    expect(coreClient.calls).toEqual([
      ['configChanged', ['pjsip', 'dialplan', 'moh']]
    ]);
  });

  // `core` starts only once `api` is healthy (§6.3), so on a fresh start nobody answers yet.
  it('keeps the render when core is not reachable yet', async () => {
    const db = await makeTestDb();
    const kr = testKeyring();
    await seedSettings(db);
    await seedUserWithDevice(db, kr);
    const genDir = await mkdtemp(path.join(tmpdir(), 'zamfono-gen-'));
    workDirs.genDir = genDir;
    const coreClient: CoreClient = {
      ...recordingCore(),
      configChanged: () => Promise.reject(new Error('ECONNREFUSED'))
    };

    propagateInto(genDir, coreClient);
    await propagateAtBoot(db, pino({ level: 'silent' }));

    const usersConf = await readFile(
      path.join(genDir, 'pjsip_users.conf'),
      'utf8'
    );
    expect(usersConf).toContain('[e101-abcde]');
  });
});
