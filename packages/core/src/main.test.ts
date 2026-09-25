import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, openDb } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from './ami/client.js';
import { FakeAmi } from './ami/fake.js';
import { AriClient } from './ari/client.js';
import { FakeAri } from './ari/fake.js';
import { main, reportFatalBoot } from './main.js';
import { startSweep } from './sweep.js';

// `startInternalServer` binds the fixed port 3000 (Global Constraints), which a test cannot claim;
// the real `ConfigCache`, `EventBus` and `StateStore` from the same module are kept.
vi.mock('./internal/server.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./internal/server.js')>()),
  startInternalServer: vi.fn(() =>
    Promise.resolve({ close: () => Promise.resolve() })
  )
}));

vi.mock('./sweep.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./sweep.js')>()),
  startSweep: vi.fn(() => ({ stop: vi.fn() }))
}));

const ENV_KEYS = [
  'ARI_URL',
  'ARI_PASSWORD',
  'AMI_HOST',
  'AMI_PASSWORD',
  'DB_FILE',
  'HEP_ENABLED'
] as const;

/**
 * A migrated database on disk carrying the one `settings` row the config snapshot requires
 * (`loadSnapshot` reads it with `executeTakeFirstOrThrow`). `main()` opens `DB_FILE` itself, so
 * `:memory:` would reach it as a separate, empty database.
 */
async function migratedDbFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-core-boot-'));
  const file = path.join(dir, 'zamfono.sqlite3');
  const db = openDb(file);
  await migrateForTest(db);
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+15551234', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId: didId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
  await db.destroy();
  return file;
}

describe('main', () => {
  const savedEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]])
  );

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  it('closes ARI and AMI (clearing their reconnect timers) and rejects when ARI never connects', async () => {
    // A FakeAri closed right before use frees its port but keeps the URL unreachable, so
    // ari.connect() rejects the way it would against a stack that never comes up.
    const fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    await fakeAri.close();

    process.env.ARI_URL = url;
    process.env.ARI_PASSWORD = 'ari-secret';
    process.env.AMI_HOST = '127.0.0.1:1';
    process.env.AMI_PASSWORD = 'ami-secret';
    process.env.DB_FILE = ':memory:';
    process.env.HEP_ENABLED = 'false';

    const ariClose = vi.spyOn(AriClient.prototype, 'close');
    const amiClose = vi.spyOn(AmiClient.prototype, 'close');

    await expect(main()).rejects.toBeInstanceOf(Error);

    expect(ariClose).toHaveBeenCalledTimes(1);
    expect(amiClose).toHaveBeenCalledTimes(1);
  });

  it('starts the minute sweep, so a scope entering or leaving OOO emits a transition', async () => {
    const fakeAri = new FakeAri();
    const fakeAmi = new FakeAmi();
    const ari = await fakeAri.listen();
    const ami = await fakeAmi.listen();
    vi.mocked(startSweep).mockClear();

    process.env.ARI_URL = ari.url;
    process.env.ARI_PASSWORD = 'ari-secret';
    process.env.AMI_HOST = `${ami.host}:${ami.port}`;
    process.env.AMI_PASSWORD = 'ami-secret';
    process.env.DB_FILE = await migratedDbFile();
    process.env.HEP_ENABLED = 'false';

    const booted = await main();
    try {
      expect(startSweep).toHaveBeenCalledTimes(1);
    } finally {
      await booted.close();
      await fakeAri.close();
      await fakeAmi.close();
    }
  });

  it('stops the sweep when the booted process is closed', async () => {
    const fakeAri = new FakeAri();
    const fakeAmi = new FakeAmi();
    const ari = await fakeAri.listen();
    const ami = await fakeAmi.listen();
    const stop = vi.fn();
    vi.mocked(startSweep).mockClear().mockReturnValue({ stop });

    process.env.ARI_URL = ari.url;
    process.env.ARI_PASSWORD = 'ari-secret';
    process.env.AMI_HOST = `${ami.host}:${ami.port}`;
    process.env.AMI_PASSWORD = 'ami-secret';
    process.env.DB_FILE = await migratedDbFile();
    process.env.HEP_ENABLED = 'false';

    const booted = await main();
    await booted.close();
    await fakeAri.close();
    await fakeAmi.close();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('reportFatalBoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with code 1', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    expect(() => {
      reportFatalBoot(new Error('boot failed'));
    }).toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    consoleError.mockRestore();
  });
});
