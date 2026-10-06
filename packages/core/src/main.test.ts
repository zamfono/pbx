import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { nowIso, openDb } from '@zamfono/shared';
import { migrateForTest, seedSettings } from '@zamfono/shared/testDb.js';

import { AmiClient } from './ami/client.js';
import { AriClient } from './ari/client.js';
import { Pipeline } from './calls/pipeline.js';
import { main, reportFatalBoot } from './main.js';
import { STOP_DRAIN_MS } from './stop.js';
import { startSweep } from './sweep.js';
import { FakeAmi } from './testing/ami/fake.js';
import { FakeAri } from './testing/ari/fake.js';
import { defaultChannel } from './testing/ari/fakeChannel.js';
import { eventually, flush } from './testing/eventually.js';

// `startInternalServer` binds the fixed port 3000 (Global Constraints), which a test cannot claim;
// the real `ConfigCache`, `EventBus` and `StateStore` from the same module are kept.
vi.mock('./internal/server.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./internal/server.js')>()),
  startInternalServer: vi.fn(() =>
    Promise.resolve({ close: () => Promise.resolve() })
  )
}));

const logged = vi.hoisted(() => [] as { level: string; args: unknown[] }[]);
vi.mock('pino', () => ({
  default: () =>
    Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map(level => [
        level,
        (...args: unknown[]) => {
          logged.push({ level, args });
        }
      ])
    )
}));

vi.mock('./sweep.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./sweep.js')>()),
  startSweep: vi.fn(() => ({ stop: vi.fn() }))
}));

/**
 * A migrated database on disk carrying the one `settings` row the config snapshot requires
 * (`loadSnapshot` reads it with `executeTakeFirstOrThrow`). `main()` opens `DB_FILE` itself, so
 * `:memory:` would reach it as a separate, empty database.
 */
async function migratedDbFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-core-boot-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'zamfono.sqlite3');
  const db = openDb(file);
  await migrateForTest(db);
  await seedSettings(db);
  await db.destroy();
  return file;
}

describe('main', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('closes ARI and AMI (clearing their reconnect timers) and rejects when ARI never connects', async () => {
    // A FakeAri closed right before use frees its port but keeps the URL unreachable, so
    // ari.connect() rejects the way it would against a stack that never comes up.
    const fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    await fakeAri.close();

    vi.stubEnv('ARI_URL', url);
    vi.stubEnv('ARI_PASSWORD', 'ari-secret');
    vi.stubEnv('AMI_HOST', '127.0.0.1:1');
    vi.stubEnv('AMI_PASSWORD', 'ami-secret');
    vi.stubEnv('EXTERNAL_IPV4', '192.0.2.10');
    vi.stubEnv('DB_FILE', ':memory:');
    vi.stubEnv('HEP_ENABLED', 'false');

    const ariClose = vi.spyOn(AriClient.prototype, 'close');
    const amiClose = vi.spyOn(AmiClient.prototype, 'close');

    await expect(main()).rejects.toBeInstanceOf(Error);

    expect(ariClose).toHaveBeenCalledTimes(1);
    expect(amiClose).toHaveBeenCalledTimes(1);
  });

  it('starts the OOO/hours sweep, so a scope entering or leaving OOO emits a transition', async () => {
    const fakeAri = new FakeAri();
    const fakeAmi = new FakeAmi();
    const ari = await fakeAri.listen();
    const ami = await fakeAmi.listen();
    vi.mocked(startSweep).mockClear();

    vi.stubEnv('ARI_URL', ari.url);
    vi.stubEnv('ARI_PASSWORD', 'ari-secret');
    vi.stubEnv('AMI_HOST', `${ami.host}:${ami.port}`);
    vi.stubEnv('AMI_PASSWORD', 'ami-secret');
    vi.stubEnv('EXTERNAL_IPV4', '192.0.2.10');
    vi.stubEnv('DB_FILE', await migratedDbFile());
    vi.stubEnv('HEP_ENABLED', 'false');

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

    vi.stubEnv('ARI_URL', ari.url);
    vi.stubEnv('ARI_PASSWORD', 'ari-secret');
    vi.stubEnv('AMI_HOST', `${ami.host}:${ami.port}`);
    vi.stubEnv('AMI_PASSWORD', 'ami-secret');
    vi.stubEnv('EXTERNAL_IPV4', '192.0.2.10');
    vi.stubEnv('DB_FILE', await migratedDbFile());
    vi.stubEnv('HEP_ENABLED', 'false');

    const booted = await main();
    await booted.close();
    await fakeAri.close();
    await fakeAmi.close();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('stopping on SIGTERM or SIGINT', () => {
  let fakeAri: FakeAri;
  let fakeAmi: FakeAmi;
  let listenersBefore = new Set<unknown>();

  /** Boots `main` against fakes, with one inbound call's handling stalled on `io`. */
  async function bootWithStalledCall(io: Promise<void>): Promise<void> {
    fakeAri = new FakeAri();
    fakeAmi = new FakeAmi();
    const ari = await fakeAri.listen();
    const ami = await fakeAmi.listen();
    vi.stubEnv('ARI_URL', ari.url);
    vi.stubEnv('ARI_PASSWORD', 'ari-secret');
    vi.stubEnv('AMI_HOST', `${ami.host}:${ami.port}`);
    vi.stubEnv('AMI_PASSWORD', 'ami-secret');
    vi.stubEnv('EXTERNAL_IPV4', '192.0.2.10');
    vi.stubEnv('DB_FILE', await migratedDbFile());
    vi.stubEnv('HEP_ENABLED', 'false');
    listenersBefore = new Set([
      ...process.listeners('SIGTERM'),
      ...process.listeners('SIGINT')
    ]);
    await main();
    const handleStasisStart = vi
      .spyOn(Pipeline.prototype, 'handleStasisStart')
      .mockReturnValue(io);
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['inbound', '+15551234'],
      channel: defaultChannel({ id: 'caller' })
    });
    await eventually(() => {
      expect(handleStasisStart).toHaveBeenCalledTimes(1);
    });
  }

  /** The `name` handlers `main` added, leaving out the test runner's own. */
  function handlersOf(name: 'SIGTERM' | 'SIGINT') {
    return process
      .listeners(name)
      .filter(listener => !listenersBefore.has(listener));
  }

  function signal(name: 'SIGTERM' | 'SIGINT'): void {
    for (const listener of handlersOf(name)) {
      listener(name);
    }
  }

  afterEach(async () => {
    for (const name of ['SIGTERM', 'SIGINT'] as const) {
      for (const listener of handlersOf(name)) {
        process.off(name, listener);
      }
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    logged.length = 0;
    await fakeAri.close();
    await fakeAmi.close();
  });

  it('closes ARI only once the event handling in progress has finished, then exits 0', async () => {
    const { promise: io, resolve: finishIo } =
      Promise.withResolvers<undefined>();
    await bootWithStalledCall(io);
    const ariClose = vi.spyOn(AriClient.prototype, 'close');
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    signal('SIGTERM');
    await flush();
    expect(ariClose).not.toHaveBeenCalled();

    finishIo(undefined);
    await eventually(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(ariClose).toHaveBeenCalledTimes(1);
    expect(logged.map(entry => entry.args.at(-1))).toEqual(
      expect.arrayContaining(['core stopping', 'core stopped'])
    );
  });

  it('a second signal during the stop starts no second one', async () => {
    const { promise: io, resolve: finishIo } =
      Promise.withResolvers<undefined>();
    await bootWithStalledCall(io);
    const ariClose = vi.spyOn(AriClient.prototype, 'close');
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    signal('SIGTERM');
    signal('SIGINT');
    finishIo(undefined);
    await eventually(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    await flush();

    expect(ariClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(
      logged.filter(entry => entry.args.at(-1) === 'core stopping')
    ).toHaveLength(1);
  });

  it('logs the handling still in progress after STOP_DRAIN_MS and exits', async () => {
    await bootWithStalledCall(Promise.withResolvers<undefined>().promise);
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    signal('SIGTERM');
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS);
    vi.useRealTimers();

    await eventually(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(logged).toContainEqual({
      level: 'warn',
      args: [
        {
          handling: [{ event: 'StasisStart', callId: null }],
          windingDown: [],
          waitedMs: STOP_DRAIN_MS
        },
        'core stopping before its calls were wound down'
      ]
    });
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
