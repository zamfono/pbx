import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db, type Envelope } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { Presence } from '../presence.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger, testActions } from '../testing/pipelineDeps.js';
import { EventBus } from './eventBus.js';
import { startInternalServer } from './server.js';
import { ConfigCache } from './snapshot.js';
import { StateStore } from './stateStore.js';

const ANY_FREE_PORT = 0;
const HTTP_NO_CONTENT = 204;

/** The settings row, a user with extension 101 and one device, `e101-dabc`. */
async function seedUserWithDevice(db: Db): Promise<string> {
  const userId = newId();
  const targetId = newId();
  const didId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Anna',
      email: 'anna@example.com',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, userId })
    .execute();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+15550001', targetId, createdAt: nowIso() })
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
  await db.insertInto('extensions').values({ ext: '101', userId }).execute();
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
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let close: () => Promise<void>;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
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
    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field names (§9.3 ContactStatusChange)
      contact_info: { aor: 'e101-dabc', contact_status: 'Reachable' }
    });
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
        trunks: { refreshMonitoring: () => Promise.resolve() }
      },
      ANY_FREE_PORT
    );
    close = started.close;
    const events: Envelope[] = [];
    bus.subscribe(envelope => events.push(envelope));

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
        presence: { refreshAll: () => Promise.resolve() },
        trunks: {
          refreshMonitoring: () => {
            invalidatedFirst = invalidated;
            return Promise.resolve();
          }
        }
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
