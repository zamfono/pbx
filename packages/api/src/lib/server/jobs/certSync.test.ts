import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db, type StateResponse } from '@zamfono/shared';

import type { CoreClient } from '../coreClient.js';
import { makeTestDb } from '../testDb.js';
import {
  CertSync,
  certSyncStatus,
  notifyCertSync,
  startCertSync
} from './certSync.js';

const FQDN = 'pbx.example.com';
const DAY_MS = 24 * 60 * 60 * 1000;

type StubCoreClient = CoreClient & {
  configChangedCalls: unknown[][];
  /** Live calls `state()` reports; an empty list is an idle system (§6.4 "Maintenance gate"). */
  liveCalls: StateResponse['calls'];
};

const LIVE_CALL: StateResponse['calls'][number] = {
  callId: 'call-1',
  direction: 'inbound',
  from: '+491701234567',
  to: '+490000000',
  state: 'up',
  startedAt: '2026-01-01T00:00:00.000Z',
  ringGroupId: null,
  userIds: [],
  connectedUserIds: []
};

function stubCoreClient(): StubCoreClient {
  const configChangedCalls: unknown[][] = [];
  const client: StubCoreClient = {
    configChangedCalls,
    liveCalls: [],
    configChanged: kinds => {
      configChangedCalls.push(kinds);
      return Promise.resolve();
    },
    state: () =>
      Promise.resolve({
        calls: client.liveCalls,
        trunks: {},
        trunkChannels: {},
        presence: {},
        registeredDevices: 0,
        recordingMixFailures: 0,
        asteriskChannels: client.liveCalls.length,
        recordingsInProgress: 0
      }),
    originate: () => Promise.reject(new Error('not used')),
    transfer: () => Promise.reject(new Error('not used')),
    pickup: () => Promise.reject(new Error('not used')),
    hangup: () => Promise.reject(new Error('not used')),
    park: () => Promise.reject(new Error('not used')),
    parked: () => Promise.reject(new Error('not used')),
    mwi: () => Promise.reject(new Error('not used'))
  };
  return client;
}

/** Places `crt`/`key` bytes where the `proxy` image's `cert_obtained` hook writes them
 * (images/proxy/zamfono-cert-hook: `zamfono/cert.pem`/`privkey.pem` under `caddyDataDir`). */
async function seedCaddyCert(
  caddyDataDir: string,
  crt: Buffer,
  key: Buffer
): Promise<void> {
  const dir = path.join(caddyDataDir, 'zamfono');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'cert.pem'), crt);
  await writeFile(path.join(dir, 'privkey.pem'), key);
}

async function seedCurrentCert(
  genDir: string,
  crt: Buffer,
  key: Buffer
): Promise<void> {
  const dir = path.join(genDir, 'tls');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'cert.pem'), crt);
  await writeFile(path.join(dir, 'privkey.pem'), key);
}

/** A self-signed certificate (§6.4 "Fresh stack" placeholder): its own issuer. */
function selfSignedCert(workDir: string): { crt: Buffer; key: Buffer } {
  const keyPath = path.join(workDir, `${newId()}.key`);
  const crtPath = path.join(workDir, `${newId()}.crt`);
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=self-signed',
    '-keyout',
    keyPath,
    '-out',
    crtPath
  ]);
  return {
    crt: execFileSync('cat', [crtPath]),
    key: execFileSync('cat', [keyPath])
  };
}

/** A CA-issued certificate valid for `days` from now: its issuer differs from its subject. */
function caIssuedCert(
  workDir: string,
  days: number
): { crt: Buffer; key: Buffer } {
  const caKey = path.join(workDir, `${newId()}-ca.key`);
  const caCrt = path.join(workDir, `${newId()}-ca.crt`);
  const leafKey = path.join(workDir, `${newId()}-leaf.key`);
  const leafCsr = path.join(workDir, `${newId()}-leaf.csr`);
  const leafCrt = path.join(workDir, `${newId()}-leaf.crt`);
  execFileSync('openssl', ['genrsa', '-out', caKey, '2048']);
  execFileSync('openssl', [
    'req',
    '-x509',
    '-new',
    '-key',
    caKey,
    '-subj',
    '/CN=Test CA',
    '-days',
    '3650',
    '-out',
    caCrt
  ]);
  execFileSync('openssl', ['genrsa', '-out', leafKey, '2048']);
  execFileSync('openssl', [
    'req',
    '-new',
    '-key',
    leafKey,
    '-subj',
    `/CN=${FQDN}`,
    '-out',
    leafCsr
  ]);
  execFileSync('openssl', [
    'x509',
    '-req',
    '-in',
    leafCsr,
    '-CA',
    caCrt,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-days',
    String(days),
    '-out',
    leafCrt
  ]);
  return {
    crt: execFileSync('cat', [leafCrt]),
    key: execFileSync('cat', [leafKey])
  };
}

/** A tenant OOO rule spanning `[startsInDays, expiresInDays)` from now, for a far scheduled moment. */
async function seedFarOoo(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  await db
    .insertInto('oooRules')
    .values({
      id: newId(),
      scopeUserId: null,
      scopeRingGroupId: null,
      scopeMenuId: null,
      active: 1,
      startsAt: new Date(Date.now() + 6 * DAY_MS).toISOString(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      targetId,
      createdAt: nowIso()
    })
    .execute();
}

async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const mainDidId = newId();
  await db
    .insertInto('dids')
    .values({
      id: mainDidId,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
    .execute();
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

describe('CertSync', () => {
  const work: { dir?: string } = {};

  afterEach(async () => {
    const dir = work.dir;
    work.dir = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeDirs(): Promise<{
    genDir: string;
    caddyDataDir: string;
    workDir: string;
  }> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'zamfono-certsync-'));
    work.dir = workDir;
    const genDir = path.join(workDir, 'gen');
    const caddyDataDir = path.join(workDir, 'caddy-data');
    await mkdir(genDir, { recursive: true });
    await mkdir(caddyDataDir, { recursive: true });
    return { genDir, caddyDataDir, workDir };
  }

  it('reports missing while the hook has not copied a certificate onto caddy-data yet', async () => {
    const { genDir, caddyDataDir } = await makeDirs();
    const db = await makeTestDb();
    const coreClient = stubCoreClient();
    const sync = new CertSync({
      db,
      coreClient,
      genDir,
      caddyDataDir
    });

    await expect(sync.run()).resolves.toBe('missing');
    expect(coreClient.configChangedCalls).toEqual([]);
  });

  it('does not copy when the source matches the currently installed certificate', async () => {
    const { genDir, caddyDataDir } = await makeDirs();
    const same = Buffer.from('identical certificate bytes');
    await seedCaddyCert(caddyDataDir, same, Buffer.from('key'));
    await seedCurrentCert(genDir, same, Buffer.from('key'));
    const db = await makeTestDb();
    const coreClient = stubCoreClient();

    await expect(
      new CertSync({ db, coreClient, genDir, caddyDataDir }).run()
    ).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([]);
  });

  it('copies immediately when no certificate is installed yet (fresh stack)', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const source = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, source.crt, source.key);
    const db = await makeTestDb();
    const coreClient = stubCoreClient();

    await expect(
      new CertSync({ db, coreClient, genDir, caddyDataDir }).run()
    ).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
    const installed = await readFile(path.join(genDir, 'tls', 'cert.pem'));
    expect(installed.equals(source.crt)).toBe(true);
    const keyStat = await stat(path.join(genDir, 'tls', 'privkey.pem'));
    // eslint-disable-next-line no-bitwise -- the permission bits, isolated from the file-type bits `mode` also carries
    expect(keyStat.mode & 0o777).toBe(0o600);
  });

  it("copies nothing while the key on caddy-data is not the certificate's, then the matching pair", async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const previous = caIssuedCert(workDir, 3650);
    const renewed = caIssuedCert(workDir, 3650);
    // The hook has renamed the new chain into place but not yet the new key.
    await seedCaddyCert(caddyDataDir, renewed.crt, previous.key);
    const db = await makeTestDb();
    const coreClient = stubCoreClient();
    const sync = new CertSync({ db, coreClient, genDir, caddyDataDir });

    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([]);
    await expect(stat(path.join(genDir, 'tls', 'cert.pem'))).rejects.toThrow();

    await seedCaddyCert(caddyDataDir, renewed.crt, renewed.key);
    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
    const installedKey = await readFile(
      path.join(genDir, 'tls', 'privkey.pem')
    );
    expect(installedKey.equals(renewed.key)).toBe(true);
  });

  it('copies immediately when the installed certificate is still the self-signed placeholder', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const placeholder = selfSignedCert(workDir);
    await seedCurrentCert(genDir, placeholder.crt, placeholder.key);
    const source = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, source.crt, source.key);
    const db = await makeTestDb();
    const coreClient = stubCoreClient();

    await expect(
      new CertSync({ db, coreClient, genDir, caddyDataDir }).run()
    ).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
  });

  it('retries only the reload on the next poll after configChanged rejects, without re-copying', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const source = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, source.crt, source.key);
    const db = await makeTestDb();
    const coreClient = stubCoreClient();
    let shouldFail = true;
    coreClient.configChanged = kinds => {
      coreClient.configChangedCalls.push(kinds);
      return shouldFail
        ? Promise.reject(new Error('core unavailable'))
        : Promise.resolve();
    };
    const sync = new CertSync({
      db,
      coreClient,
      genDir,
      caddyDataDir
    });

    await expect(sync.run()).rejects.toThrow('core unavailable');
    const installed = await readFile(path.join(genDir, 'tls', 'cert.pem'));
    expect(installed.equals(source.crt)).toBe(true);

    shouldFail = false;
    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip'], ['pjsip']]);
  });

  it('defers a working certificate change to the next maintenance moment', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const current = caIssuedCert(workDir, 3650);
    await seedCurrentCert(genDir, current.crt, current.key);
    const nextCert = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, nextCert.crt, nextCert.key);
    const db = await makeTestDb();
    await seedSettings(db);
    await seedFarOoo(db);
    const coreClient = stubCoreClient();

    await expect(
      new CertSync({ db, coreClient, genDir, caddyDataDir }).run()
    ).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([]);
  });

  it('applies a deferred change once the resolved maintenance moment is reached on a later poll', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const current = caIssuedCert(workDir, 3650);
    await seedCurrentCert(genDir, current.crt, current.key);
    const nextCert = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, nextCert.crt, nextCert.key);
    const db = await makeTestDb();
    await seedSettings(db);
    delete process.env.TLS_RELOAD_HOUR;
    const coreClient = stubCoreClient();
    // Before the default 03:00 maintenance hour.
    let now = new Date('2026-01-01T01:00:00Z');
    const sync = new CertSync({
      db,
      coreClient,
      genDir,
      caddyDataDir,
      now: () => now
    });

    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([]);

    // Past 03:00: the deferred change comes due.
    now = new Date('2026-01-01T04:00:00Z');
    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
    const installed = await readFile(path.join(genDir, 'tls', 'cert.pem'));
    expect(installed.equals(nextCert.crt)).toBe(true);
  });

  it('waits at the maintenance moment while a call is live, then applies once the system is idle', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const current = caIssuedCert(workDir, 3650);
    await seedCurrentCert(genDir, current.crt, current.key);
    const nextCert = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, nextCert.crt, nextCert.key);
    const db = await makeTestDb();
    await seedSettings(db);
    delete process.env.TLS_RELOAD_HOUR;
    const coreClient = stubCoreClient();
    coreClient.liveCalls = [LIVE_CALL];
    let now = new Date('2026-01-01T01:00:00Z');
    const sync = new CertSync({
      db,
      coreClient,
      genDir,
      caddyDataDir,
      now: () => now
    });

    await expect(sync.run()).resolves.toBe('ok');
    now = new Date('2026-01-01T03:00:00Z');
    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([]);

    coreClient.liveCalls = [];
    now = new Date('2026-01-01T03:10:00Z');
    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
  });

  it('gives up two hours past the moment while the system stays busy, until the next moment', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const current = caIssuedCert(workDir, 3650);
    await seedCurrentCert(genDir, current.crt, current.key);
    const nextCert = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, nextCert.crt, nextCert.key);
    const db = await makeTestDb();
    await seedSettings(db);
    delete process.env.TLS_RELOAD_HOUR;
    const coreClient = stubCoreClient();
    coreClient.liveCalls = [LIVE_CALL];
    let now = new Date('2026-01-01T02:00:00Z');
    const sync = new CertSync({
      db,
      coreClient,
      genDir,
      caddyDataDir,
      now: () => now
    });

    await expect(sync.run()).resolves.toBe('ok');
    now = new Date('2026-01-01T03:00:00Z');
    await expect(sync.run()).resolves.toBe('ok');
    coreClient.liveCalls = [];
    // Past the two-hour wait: the next chance is tomorrow's 03:00, idle or not.
    now = new Date('2026-01-01T05:30:00Z');
    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([]);
    expect(
      await db.selectFrom('maintenanceGate').selectAll().execute()
    ).toEqual([
      {
        work: 'certSync',
        gaveUpAt: '2026-01-01T05:30:00.000Z',
        reason: 'live calls 1, Asterisk channels 1, recordings in progress 0',
        consecutiveGiveUps: 1
      }
    ]);

    now = new Date('2026-01-02T03:00:00Z');
    await expect(sync.run()).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
  });

  it('applies the placeholder replacement at once even while a call is live', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const placeholder = selfSignedCert(workDir);
    await seedCurrentCert(genDir, placeholder.crt, placeholder.key);
    const source = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, source.crt, source.key);
    const db = await makeTestDb();
    const coreClient = stubCoreClient();
    coreClient.liveCalls = [LIVE_CALL];

    await expect(
      new CertSync({ db, coreClient, genDir, caddyDataDir }).run()
    ).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
  });

  it('applies immediately when the installed certificate expires before the scheduled moment (safety valve)', async () => {
    const { genDir, caddyDataDir, workDir } = await makeDirs();
    const expiringSoon = caIssuedCert(workDir, 1);
    await seedCurrentCert(genDir, expiringSoon.crt, expiringSoon.key);
    const nextCert = caIssuedCert(workDir, 3650);
    await seedCaddyCert(caddyDataDir, nextCert.crt, nextCert.key);
    const db = await makeTestDb();
    await seedSettings(db);
    await seedFarOoo(db);
    const coreClient = stubCoreClient();

    await expect(
      new CertSync({ db, coreClient, genDir, caddyDataDir }).run()
    ).resolves.toBe('ok');
    expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
  });
});

describe('startCertSync', () => {
  const work: { dir?: string } = {};

  afterEach(async () => {
    const dir = work.dir;
    work.dir = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // §6.4: `POST /internal/certificate` (routes/internal/certificate/+server.ts) calls
  // `notifyCertSync()` to run a pass right away, instead of waiting for the
  // hourly poll (POLL_INTERVAL_MS) that would otherwise be the only thing to pick up a
  // certificate the hook wrote after the scheduler's own start-of-process pass ran.
  it('notifyCertSync() picks up a certificate the hook wrote after start, without waiting for the poll', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'zamfono-certsync-'));
    work.dir = workDir;
    const genDir = path.join(workDir, 'gen');
    const caddyDataDir = path.join(workDir, 'caddy-data');
    await mkdir(genDir, { recursive: true });
    await mkdir(caddyDataDir, { recursive: true });
    const db = await makeTestDb();
    const coreClient = stubCoreClient();
    expect(certSyncStatus()).toBe('unknown');

    const scheduler = startCertSync({ db, coreClient, genDir, caddyDataDir });
    try {
      // Nothing under caddyDataDir yet: the start-of-process pass finds no hook copy.
      await vi.waitFor(() => {
        expect(scheduler.status()).toBe('missing');
      });
      expect(coreClient.configChangedCalls).toEqual([]);

      const source = caIssuedCert(workDir, 3650);
      await seedCaddyCert(caddyDataDir, source.crt, source.key);
      notifyCertSync();

      await vi.waitFor(() => {
        expect(certSyncStatus()).toBe('ok');
      });
      expect(coreClient.configChangedCalls).toEqual([['pjsip']]);
      const installed = await readFile(path.join(genDir, 'tls', 'cert.pem'));
      expect(installed.equals(source.crt)).toBe(true);
    } finally {
      scheduler.stop();
    }
  });
});
