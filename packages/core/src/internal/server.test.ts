import { once } from 'node:events';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  HEALTH_CONTENT_TYPE,
  HTTP_BAD_REQUEST,
  HTTP_CONTENT_TOO_LARGE,
  HTTP_NO_CONTENT,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  newId,
  nowIso,
  rawDataToString,
  resolveVersion,
  type Db,
  type Presence,
  type TrunkStatus
} from '@zamfono/shared';
import { migratedTestDb, seedSettings } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import type { Logger } from '../ari/types.js';
import { newCall } from '../calls/call.js';
import { FakeAri } from '../testing/ari/fake.js';
import {
  idlePresence,
  idleRecorder,
  noopLogger,
  testActions
} from '../testing/pipelineDeps.js';
import { EventBus } from './eventBus.js';
import { MAX_INTERNAL_BODY_BYTES } from './http.js';
import { startInternalServer } from './server.js';
import { ConfigCache } from './snapshot.js';
import { StateStore } from './stateStore.js';

// The version every server of this suite reports on `/internal/version`.
const VERSION = resolveVersion({
  ZAMFONO_VERSION: '0.0.5',
  ZAMFONO_REVISION: 'a04ac57deadbeef'
});

// Every server binds whatever port is free (`0`), never a fixed one another suite running on the
// same host at the same time may already hold.
const ANY_FREE_PORT = 0;
// What the server under test logged at error, the message and its fields.
const errorsLogged: { fields: unknown; msg: unknown }[] = [];
const serverLogger: Logger = {
  ...noopLogger,
  error: (fields, msg) => {
    errorsLogged.push({ fields, msg });
  }
};

describe('startInternalServer', () => {
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let cache: ConfigCache;
  let state: StateStore;
  let presence: ReturnType<typeof idlePresence>;
  let recorder: typeof idleRecorder;
  let close: () => Promise<void>;
  let port: number;

  beforeEach(async () => {
    db = await migratedTestDb();
    await seedSettings(db);
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
    presence = idlePresence();
    recorder = { ...idleRecorder };
    errorsLogged.length = 0;
    const started = await startInternalServer(
      {
        db,
        ari,
        log: serverLogger,
        cache,
        state,
        bus: new EventBus(),
        actions: testActions(ari, db),
        presence,
        recorder,
        trunks: { refreshMonitoring: () => Promise.resolve() },
        version: VERSION
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

  it('answers /healthz as health+json with core:database and core:ari, 503 once ARI drops', async () => {
    const healthy = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthy.status).toBe(HTTP_OK);
    expect(healthy.headers.get('content-type')).toBe(HEALTH_CONTENT_TYPE);
    expect(healthy.headers.get('cache-control')).toBe('no-store');
    await expect(healthy.json()).resolves.toEqual({
      status: 'pass',
      checks: {
        'core:database': [{ status: 'pass' }],
        'core:ari': [{ status: 'pass' }]
      }
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
    await expect(unhealthy.json()).resolves.toEqual({
      status: 'fail',
      checks: {
        'core:database': [{ status: 'pass' }],
        'core:ari': [{ status: 'fail' }]
      }
    });
  });

  it('answers /healthz with core:database failing once the database is closed', async () => {
    await db.destroy();
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    await expect(response.json()).resolves.toMatchObject({
      status: 'fail',
      checks: { 'core:database': [{ status: 'fail' }] }
    });
  });

  it('answers /readyz 200 with an empty body while ready, 503 once ARI drops', async () => {
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(HTTP_OK);
    expect(await ready.text()).toBe('');

    const disconnected = new Promise<void>(resolve => {
      ari.once('disconnected', () => {
        resolve();
      });
    });
    await fakeAri.close();
    await disconnected;

    const unready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(unready.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(await unready.text()).toBe('');
  });

  it('answers /readyz 503 once the database is closed', async () => {
    await db.destroy();
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
  });

  it('answers 503 for a request whose route failed, and logs the failure with the request', async () => {
    presence.registeredDevices = () => Promise.reject(new Error('boom'));

    const response = await fetch(`http://127.0.0.1:${port}/internal/state`);

    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(errorsLogged).toEqual([
      {
        fields: expect.objectContaining({
          method: 'GET',
          path: '/internal/state'
        }) as unknown,
        msg: 'internal API request failed'
      }
    ]);
  });

  it('answers /internal/state with the StateStore snapshot and the readings derived as it is served', async () => {
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: newId(),
      from: '+15550002',
      to: '+15550001',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    const trunk: TrunkStatus = {
      status: 'registered',
      statusChangedAt: nowIso()
    };
    const available: Presence = {
      status: 'available',
      peer: null,
      ringGroupId: null,
      since: nowIso()
    };
    state.calls.set(call.id, { call, state: 'ringing', notified: new Set() });
    state.trunks.set('mainTrunk', trunk);
    state.presence.set('user1', available);
    state.trunkChannels.set('mainTrunk', 2);
    presence.registeredDevices = () => Promise.resolve(3);
    recorder.mixFailureCount = 1;
    recorder.inProgressCount = 2;
    for (let index = 0; index < 4; index += 1) {
      fakeAri.addChannel({});
    }

    const response = await fetch(`http://127.0.0.1:${port}/internal/state`);
    expect(response.status).toBe(HTTP_OK);
    await expect(response.json()).resolves.toEqual({
      calls: [
        {
          callId: call.id,
          direction: 'inbound',
          from: '+15550002',
          to: '+15550001',
          state: 'ringing',
          startedAt: call.startedAt,
          ringGroupId: null,
          userIds: [],
          connectedUserIds: [],
          legs: [{ id: call.callerLegId, role: 'caller', state: 'ringing' }]
        }
      ],
      trunks: { mainTrunk: trunk },
      trunkChannels: { mainTrunk: 2 },
      presence: { user1: available },
      registeredDevices: 3,
      recordingMixFailures: 1,
      asteriskChannels: 4,
      recordingsInProgress: 2
    });
  });

  it('answers /internal/version with the version and commit this core runs, and since when', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/version`);
    expect(response.status).toBe(HTTP_OK);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      version: '0.0.5',
      revision: 'a04ac57deadbeef',
      display: '0.0.5 (a04ac57)',
      startedAt: expect.any(String) as unknown,
      // The fake Asterisk's `startup_time`, `+0000` read as UTC.
      asteriskStartedAt: '2026-09-29T08:00:00.000Z'
    });
    expect(Date.parse(body.startedAt as string)).toBeLessThanOrEqual(
      Date.now()
    );
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
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'invalid body',
      status: HTTP_BAD_REQUEST
    });
  });

  it.each([
    ['calls/c1/transfer', { target: 102, actorUserId: 'u1' }],
    ['calls/c1/transfer', { target: '102', actorUserId: 'u1', voicemail: 1 }],
    ['calls/c1/hold', {}],
    ['calls/c1/hold', []],
    ['calls', { userId: 'u1', target: '102', actorUserId: 'u1' }]
  ])('answers 400 for a %s body its schema refuses', async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
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
        log: noopLogger,
        cache: new ConfigCache(db),
        state: new StateStore(),
        bus,
        actions: testActions(ari, db),
        presence: idlePresence(),
        recorder: idleRecorder,
        trunks: { refreshMonitoring: () => Promise.resolve() },
        version: VERSION
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

  it('closes an /internal/events socket that sends a large frame, with 1009', async () => {
    const started = await startInternalServer(
      {
        db,
        ari,
        log: noopLogger,
        cache: new ConfigCache(db),
        state: new StateStore(),
        bus: new EventBus(),
        actions: testActions(ari, db),
        presence: idlePresence(),
        recorder: idleRecorder,
        trunks: { refreshMonitoring: () => Promise.resolve() },
        version: VERSION
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
      const closed = new Promise<number>(resolve => {
        socket.once('close', code => {
          resolve(code);
        });
      });
      socket.send('x'.repeat(64 * 1024));
      // RFC 6455 §7.4.1: the close code of a frame too big to process.
      expect(await closed).toBe(1009);
    } finally {
      await started.close();
    }
  });

  it('closes while an /internal/events subscriber is still connected, ending its socket', async () => {
    const started = await startInternalServer(
      {
        db,
        ari,
        log: noopLogger,
        cache: new ConfigCache(db),
        state: new StateStore(),
        bus: new EventBus(),
        actions: testActions(ari, db),
        presence: idlePresence(),
        recorder: idleRecorder,
        trunks: { refreshMonitoring: () => Promise.resolve() },
        version: VERSION
      },
      ANY_FREE_PORT
    );
    const socket = new WebSocket(
      `ws://127.0.0.1:${started.port}/internal/events`
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    const socketClosed = new Promise<void>(resolve => {
      socket.once('close', () => {
        resolve();
      });
    });

    await started.close();
    await socketClosed;
  });

  it('answers 413 for a configChanged body over the size cap', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/configChanged`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(MAX_INTERNAL_BODY_BYTES + 1)
      }
    );
    expect(response.status).toBe(HTTP_CONTENT_TOO_LARGE);
  });

  it('does not crash the process when a client sends a malformed WS frame', async () => {
    const bus = new EventBus();
    const started = await startInternalServer(
      {
        db,
        ari,
        log: noopLogger,
        cache: new ConfigCache(db),
        state: new StateStore(),
        bus,
        actions: testActions(ari, db),
        presence: idlePresence(),
        recorder: idleRecorder,
        trunks: { refreshMonitoring: () => Promise.resolve() },
        version: VERSION
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
      // `ws` answers it with a close frame, emitting that `'error'` in the same tick.
      const closeFrame = once(socket, 'data');
      socket.write(Buffer.from([0xc2, 0x00]));
      await closeFrame;
      expect(uncaughtErrors).toEqual([]);
      socket.destroy();
    } finally {
      process.off('uncaughtException', onUncaughtException);
      await started.close();
    }
  });
});
