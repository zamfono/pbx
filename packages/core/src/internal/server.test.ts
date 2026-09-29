import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  newId,
  nowIso,
  openDb,
  type Db,
  type LiveCall,
  type Presence,
  type TrunkStatus
} from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { rawDataToString, type Logger } from '../ari/types.js';
import {
  ConfigCache,
  EventBus,
  startInternalServer,
  StateStore
} from './server.js';

// Every server binds whatever port is free (`0`), never a fixed one another suite running on the
// same host at the same time may already hold.
const ANY_FREE_PORT = 0;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVICE_UNAVAILABLE = 503;
// Over the internal server's 65536-byte cap (server.ts's `MAX_INTERNAL_BODY_BYTES`).
const OVERSIZED_BODY_BYTES = 65537;
const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/** Seeds the one settings row (and the DID/forward-target/user chain its FK requires). */
async function seedMinimalConfig(db: Db): Promise<void> {
  const userId = newId();
  const forwardTargetId = newId();
  const didId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Owner',
      email: 'owner@example.com',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('forwardTargets')
    .values({ id: forwardTargetId, userId })
    .execute();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+15550001',
      targetId: forwardTargetId,
      createdAt: nowIso()
    })
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
}

describe('startInternalServer', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let cache: ConfigCache;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let state: StateStore;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let close: () => Promise<void>;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let port: number;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedMinimalConfig(db);
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    cache = new ConfigCache(db);
    state = new StateStore();
    const started = await startInternalServer(
      {
        db,
        ari,
        cache,
        state,
        bus: new EventBus(),
        actions: null,
        presence: null
      },
      ANY_FREE_PORT
    );
    close = started.close;
    port = started.port;
  });

  afterEach(async () => {
    await close();
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('answers /healthz 200 while ARI is connected, 503 once it drops', async () => {
    const healthy = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthy.status).toBe(HTTP_OK);
    await expect(healthy.json()).resolves.toMatchObject({
      ok: true,
      ari: true,
      db: true
    });

    const disconnected = new Promise<void>(resolve => {
      ari.once('disconnected', () => {
        resolve();
      });
    });
    await fakeAri.close();
    await disconnected;

    const unhealthy = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(unhealthy.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    await expect(unhealthy.json()).resolves.toMatchObject({ ari: false });
  });

  it('answers /internal/state with the StateStore snapshot', async () => {
    const call: LiveCall = {
      callId: newId(),
      direction: 'inbound',
      from: '+15550002',
      to: '+15550001',
      state: 'ringing',
      startedAt: nowIso(),
      ringGroupId: null,
      userIds: []
    };
    const trunk: TrunkStatus = {
      status: 'registered',
      statusChangedAt: nowIso()
    };
    const presence: Presence = {
      status: 'available',
      peer: null,
      ringGroupId: null,
      since: nowIso()
    };
    state.calls.set(call.callId, call);
    state.trunks.set('mainTrunk', trunk);
    state.presence.set('user1', presence);
    state.trunkChannels.set('mainTrunk', 2);
    state.readRegisteredDevicesFrom(() => Promise.resolve(3));
    state.readRecordingMixFailuresFrom(() => 1);

    const response = await fetch(`http://127.0.0.1:${port}/internal/state`);
    expect(response.status).toBe(HTTP_OK);
    await expect(response.json()).resolves.toEqual({
      calls: [call],
      trunks: { mainTrunk: trunk },
      trunkChannels: { mainTrunk: 2 },
      presence: { user1: presence },
      registeredDevices: 3,
      recordingMixFailures: 1
    });
  });

  it('answers /internal/version with the version and commit this core runs', async () => {
    process.env.ZAMFONO_VERSION = '0.0.5';
    process.env.ZAMFONO_REVISION = 'a04ac57deadbeef';
    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/version`);
      expect(response.status).toBe(HTTP_OK);
      await expect(response.json()).resolves.toEqual({
        version: '0.0.5',
        revision: 'a04ac57deadbeef',
        display: '0.0.5 (a04ac57)'
      });
    } finally {
      delete process.env.ZAMFONO_VERSION;
      delete process.env.ZAMFONO_REVISION;
    }
  });

  it('reloads res_pjsip and invalidates the config cache on configChanged', async () => {
    const first = await cache.get();
    const second = await cache.get();
    expect(second).toBe(first);

    const response = await fetch(
      `http://127.0.0.1:${port}/internal/configChanged`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reload: ['pjsip'] })
      }
    );
    expect(response.status).toBe(HTTP_NO_CONTENT);
    expect(
      fakeAri.calls.some(
        call =>
          call.method === 'PUT' && call.path === 'asterisk/modules/res_pjsip'
      )
    ).toBe(true);

    const third = await cache.get();
    expect(third).not.toBe(second);
  });

  it('answers 400 for a malformed configChanged body without crashing the server', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/configChanged`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json'
      }
    );
    expect(response.status).toBe(HTTP_BAD_REQUEST);

    const healthy = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthy.status).toBe(HTTP_OK);
  });

  it('answers 400 for an unknown reload kind', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/configChanged`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reload: ['bogus'] })
      }
    );
    expect(response.status).toBe(HTTP_BAD_REQUEST);
  });

  it('parses the *Json config columns into the Snapshot', async () => {
    const snapshot = await cache.get();
    expect(snapshot.settings.emergencyNumbers).toEqual(['112']);
    expect(snapshot.settings.featureCodes.pickup).toBe('*8');
  });

  it('broadcasts an Envelope to /internal/events subscribers on bus.emit', async () => {
    const bus = new EventBus();
    const started = await startInternalServer(
      {
        db,
        ari,
        cache: new ConfigCache(db),
        state: new StateStore(),
        bus,
        actions: null,
        presence: null
      },
      ANY_FREE_PORT
    );
    try {
      const socket = new WebSocket(
        `ws://127.0.0.1:${started.port}/internal/events`
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve();
        });
        socket.once('error', reject);
      });
      const received = new Promise<string>(resolve => {
        socket.once('message', data => {
          resolve(rawDataToString(data));
        });
      });
      bus.emit({
        type: 'trunk.status',
        trunkId: 't1',
        status: 'registered'
      });
      const raw = await received;
      expect(JSON.parse(raw)).toMatchObject({
        type: 'trunk.status',
        trunkId: 't1',
        status: 'registered'
      });
      socket.close();
    } finally {
      await started.close();
    }
  });

  it('answers 413 for a configChanged body over the size cap', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/configChanged`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(OVERSIZED_BODY_BYTES)
      }
    );
    expect(response.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });

  it('does not crash the process when a client sends a malformed WS frame', async () => {
    const bus = new EventBus();
    const started = await startInternalServer(
      {
        db,
        ari,
        cache: new ConfigCache(db),
        state: new StateStore(),
        bus,
        actions: null,
        presence: null
      },
      ANY_FREE_PORT
    );
    const uncaughtErrors: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      uncaughtErrors.push(error);
    };
    process.on('uncaughtException', onUncaughtException);
    try {
      const socket = net.connect(started.port, '127.0.0.1');
      await new Promise<void>(resolve => {
        socket.once('connect', () => {
          resolve();
        });
      });
      socket.write(
        'GET /internal/events HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${started.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
      await new Promise<void>(resolve => {
        socket.once('data', () => {
          resolve();
        });
      });
      // FIN=1, RSV1=1 (unnegotiated), opcode=binary: a protocol violation `ws` reports as
      // a socket `'error'` rather than a parsed frame.
      socket.write(Buffer.from([0xc2, 0x00]));
      await new Promise(resolve => {
        setTimeout(resolve, 50);
      });
      expect(uncaughtErrors).toEqual([]);
      socket.destroy();
    } finally {
      process.off('uncaughtException', onUncaughtException);
      await started.close();
    }
  });
});
