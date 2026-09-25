import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import type { CoreClient } from './coreClient.js';
import { propagateAtBoot, propagateConfig } from './propagation.js';
import { encrypt, keyringFromEnv, type Keyring } from './secretbox.js';
import { makeTestDb } from './testDb.js';

const KEY_BYTE_LENGTH = 32;

function testKeyring(): Keyring {
  return keyringFromEnv({
    SECRETBOX_KEY: `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`
  });
}

/** Inserts a live `dids` row targeting an external number, returning its id. */
async function insertDid(db: Db, number: string): Promise<string> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: number,
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, label: null, targetId, createdAt: nowIso() })
    .execute();
  return id;
}

async function seedSettings(db: Db): Promise<void> {
  const mainDidId = await insertDid(db, '+490000000');
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId
    })
    .execute();
}

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

type StubCoreClient = CoreClient & { calls: unknown[][] };

function stubCoreClient(): StubCoreClient {
  const calls: unknown[][] = [];
  return {
    calls,
    configChanged: kinds => {
      calls.push(['configChanged', kinds]);
      return Promise.resolve();
    },
    state: () => Promise.reject(new Error('not used')),
    originate: () => Promise.reject(new Error('not used')),
    transfer: () => Promise.reject(new Error('not used')),
    pickup: () => Promise.reject(new Error('not used')),
    hangup: () => Promise.reject(new Error('not used')),
    mwi: () => Promise.reject(new Error('not used'))
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
    const coreClient = stubCoreClient();

    await propagateConfig(db, ['pjsip', 'dialplan'], {
      kr,
      coreClient,
      genDir
    });

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
      await propagateConfig(db, ['pjsip', 'moh'], {
        kr,
        coreClient: stubCoreClient(),
        genDir
      });
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
    const coreClient = stubCoreClient();

    await propagateAtBoot(db, pino({ level: 'silent' }), {
      kr,
      coreClient,
      genDir
    });

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
      ...stubCoreClient(),
      configChanged: () => Promise.reject(new Error('ECONNREFUSED'))
    };

    await propagateAtBoot(db, pino({ level: 'silent' }), {
      kr,
      coreClient,
      genDir
    });

    const usersConf = await readFile(
      path.join(genDir, 'pjsip_users.conf'),
      'utf8'
    );
    expect(usersConf).toContain('[e101-abcde]');
  });
});
