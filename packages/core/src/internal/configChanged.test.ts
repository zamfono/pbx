import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HTTP_NO_CONTENT,
  newId,
  nowIso,
  resolveVersion,
  type Db,
  type Envelope
} from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { Presence } from '../presence.js';
import { FakeAri } from '../testing/ari/fake.js';
import { peerStatusChange } from '../testing/ari/fakeChannel.js';
import { onEvents } from '../testing/busEvents.js';
import { eventually } from '../testing/eventually.js';
import {
  idlePresence,
  idleRecorder,
  noopLogger,
  testActions
} from '../testing/pipelineDeps.js';
import { seedSettings, seedUser } from '../testing/seedRows.js';
import { EventBus } from './eventBus.js';
import { startInternalServer } from './server.js';
import { ConfigCache } from './snapshot.js';
import { StateStore } from './stateStore.js';

const ANY_FREE_PORT = 0;

/** The settings row, a user with extension 101 and one device, `e101-dabc`. */
async function seedUserWithDevice(db: Db): Promise<string> {
  await seedSettings(db);
  const userId = await seedUser(db, { name: 'Anna', ext: '101' });
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: 'desk',
      kind: 'manual',
      sipUsername: 'e101-dabc',
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
  return userId;
}

describe('POST /internal/configChanged and presence (§3.1, §10.2)', () => {
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let close: () => Promise<void>;

  beforeEach(async () => {
    db = await migratedTestDb();
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
  });

  afterEach(async () => {
    await close();
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('recomputes presence after api set DND: emits `presence`, logs the transition, sets the BUSY hint', async () => {
    const userId = await seedUserWithDevice(db);
    const cache = new ConfigCache(db);
    const state = new StateStore();
    const bus = new EventBus();
    const presence = new Presence({
      log: noopLogger,
      ari,
      cache,
      state,
      bus,
      db,
      now: nowIso
    });
    await presence.resyncOnBoot();
    fakeAri.emit(peerStatusChange('e101-dabc'));
    await eventually(() => {
      expect(state.presence.get(userId)?.status).toBe('available');
    });
    const started = await startInternalServer(
      {
        db,
        ari,
        log: noopLogger,
        cache,
        state,
        bus,
        actions: testActions(ari, db),
        presence,
        recorder: idleRecorder,
        trunks: { refreshMonitoring: () => Promise.resolve() },
        version: resolveVersion({})
      },
      ANY_FREE_PORT
    );
    close = started.close;
    const events: Envelope[] = [];
    onEvents(bus, envelope => events.push(envelope));

    // What `PUT /users/{id}/presence` writes, then the propagation it triggers.
    await db
      .updateTable('users')
      .set({ dnd: 1 })
      .where('id', '=', userId)
      .execute();
    const response = await fetch(
      `http://127.0.0.1:${started.port}/internal/configChanged`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reload: [] })
      }
    );

    expect(response.status).toBe(HTTP_NO_CONTENT);
    expect(state.presence.get(userId)?.status).toBe('dnd');
    expect(events).toMatchObject([
      { type: 'presence', userId, status: 'dnd', peer: null }
    ]);
    const logRows = await db
      .selectFrom('presenceLog')
      .select('status')
      .where('userId', '=', userId)
      .orderBy('since', 'asc')
      .execute();
    expect(logRows.map(row => row.status)).toEqual([
      'offline',
      'available',
      'dnd'
    ]);
    const hints = fakeAri.calls.filter(
      call =>
        call.method === 'PUT' &&
        call.path === 'deviceStates/Stasis:presence-101'
    );
    expect(hints.at(-1)?.body).toEqual({ deviceState: 'BUSY' });
  });

  it('refreshes the trunks\' unmonitored statuses once the cache is dropped (§9.4 "Provisioning and status")', async () => {
    const cache = new ConfigCache(db);
    let invalidatedFirst: boolean | null = null;
    const invalidate = cache.invalidate.bind(cache);
    let invalidated = false;
    cache.invalidate = () => {
      invalidated = true;
      invalidate();
    };
    const started = await startInternalServer(
      {
        db,
        ari,
        log: noopLogger,
        cache,
        state: new StateStore(),
        bus: new EventBus(),
        actions: testActions(ari, db),
        presence: idlePresence(),
        recorder: idleRecorder,
        trunks: {
          refreshMonitoring: () => {
            invalidatedFirst = invalidated;
            return Promise.resolve();
          }
        },
        version: resolveVersion({})
      },
      ANY_FREE_PORT
    );
    close = started.close;

    const response = await fetch(
      `http://127.0.0.1:${started.port}/internal/configChanged`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reload: ['pjsip'] })
      }
    );

    expect(response.status).toBe(HTTP_NO_CONTENT);
    expect(invalidatedFirst).toBe(true);
  });
});
