import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from './ari/client.js';
import { EventBus } from './internal/eventBus.js';
import { ConfigCache } from './internal/snapshot.js';
import { StateStore } from './internal/stateStore.js';
import { Presence } from './presence.js';
import { FakeAri } from './testing/ari/fake.js';
import { eventually } from './testing/eventually.js';
import { noopLogger } from './testing/pipelineDeps.js';
import { seedSettings, seedUser } from './testing/seedRows.js';

// How long the fake holds a hint PUT to model a slow connection: well past the round trip of the
// refresh sent after it, so that one lands first unless the pushes are serialized.
const SLOW_HINT_PUT_MS = 100;

async function seedDevice(
  db: Db,
  userId: string,
  sipUsername: string
): Promise<void> {
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: sipUsername,
      kind: 'manual',
      sipUsername,
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
}

async function seedExtension(
  db: Db,
  ext: string,
  userId: string
): Promise<void> {
  await db.insertInto('extensions').values({ ext, userId }).execute();
}

describe('Presence', () => {
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let state: StateStore;
  let presence: Presence;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
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
    state = new StateStore();
    presence = new Presence({
      log: noopLogger,
      ari,
      cache: new ConfigCache(db),
      state,
      bus: new EventBus(),
      db,
      now: nowIso
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  function hintPuts(ext: string): { deviceState?: string }[] {
    return fakeAri.calls
      .filter(
        entry =>
          entry.method === 'PUT' &&
          entry.path === `deviceStates/Stasis:presence-${ext}`
      )
      .map(entry => entry.body as { deviceState?: string });
  }

  it('registration event flips hint from UNAVAILABLE to NOT_INUSE and appends presence_log', async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e101-dabc');
    await seedExtension(db, '101', userId);

    await presence.resyncOnBoot();
    expect(state.presence.get(userId)?.status).toBe('offline');
    expect(hintPuts('101').at(-1)).toEqual({ deviceState: 'UNAVAILABLE' });

    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field names (§9.3 ContactStatusChange)
      contact_info: { aor: 'e101-dabc', contact_status: 'Reachable' }
    });

    // The event is handled off the WebSocket: a config read, the hint's PUT, then the status and
    // its presence_log row, each awaited in turn.
    await eventually(async () => {
      expect(state.presence.get(userId)?.status).toBe('available');
      expect(hintPuts('101').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      const logRows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', userId)
        .orderBy('since', 'asc')
        .execute();
      expect(logRows.map(row => row.status)).toEqual(['offline', 'available']);
    });
  });

  it('setCallState drives RINGING/INUSE hints and appends busy presence_log rows with the call counterpart', async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e102-dabc');
    await seedExtension(db, '102', userId);

    await presence.resyncOnBoot();
    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field names (§9.3 ContactStatusChange)
      contact_info: { aor: 'e102-dabc', contact_status: 'Reachable' }
    });
    await eventually(() => {
      expect(state.presence.get(userId)?.status).toBe('available');
    });

    // §9.3 "a user: RINGING while any of their devices rings".
    presence.setCallState(userId, 'ringing', '+15557777', null, 'call-1');
    await eventually(() => {
      expect(hintPuts('102').at(-1)).toEqual({ deviceState: 'RINGING' });
      expect(state.presence.get(userId)).toMatchObject({
        status: 'busy',
        peer: '+15557777'
      });
    });

    // §9.3 "... INUSE in a call": the hint moves on even though the call counterpart is
    // unchanged, so the presence status itself (still `busy`) logs no second row for it.
    presence.setCallState(userId, 'inCall', '+15557777', null, 'call-1');
    await eventually(() => {
      expect(hintPuts('102').at(-1)).toEqual({ deviceState: 'INUSE' });
    });

    presence.setCallState(userId, 'idle', null, null, 'call-1');
    await eventually(() => {
      expect(hintPuts('102').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      expect(state.presence.get(userId)?.status).toBe('available');
    });

    const logRows = await eventually(async () => {
      const rows = await db
        .selectFrom('presenceLog')
        .select(['status', 'peer'])
        .where('userId', '=', userId)
        .orderBy('since', 'asc')
        .execute();
      expect(rows).toHaveLength(4);
      return rows;
    });
    // Exactly one `busy` row for the ring→inCall pair (same peer, deduplicated), between the
    // boot registration flip and the return to idle (§10.2 "Presence and BLF": "Every presence
    // transition is appended to presence_log with the call counterpart ... while busy").
    expect(logRows.map(row => row.status)).toEqual([
      'offline',
      'available',
      'busy',
      'available'
    ]);
    expect(logRows[2]).toEqual({ status: 'busy', peer: '+15557777' });
  });

  it('setCallState is reference-counted per call id: a second call ending never clears a user still bridged in an earlier one', async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e103-dabc');
    await seedExtension(db, '103', userId);
    await presence.resyncOnBoot();
    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field names (§9.3 ContactStatusChange)
      contact_info: { aor: 'e103-dabc', contact_status: 'Reachable' }
    });
    await eventually(() => {
      expect(state.presence.get(userId)?.status).toBe('available');
    });

    // The first call bridges `userId` in (§9.3 "... INUSE in a call").
    presence.setCallState(userId, 'inCall', '+15557777', null, 'call-1');
    await eventually(() => {
      expect(hintPuts('103').at(-1)).toEqual({ deviceState: 'INUSE' });
      expect(state.presence.get(userId)?.status).toBe('busy');
    });

    // A second call rings the same user as call waiting, then gives up unanswered — its own
    // `idle` must not clear the flag the still-live first call set. Each refresh PUTs the hint,
    // so both have been judged once two more PUTs have landed.
    const putsBefore = hintPuts('103').length;
    presence.setCallState(userId, 'ringing', '+15558888', null, 'call-2');
    await eventually(() => {
      expect(hintPuts('103').length).toBeGreaterThanOrEqual(putsBefore + 1);
    });
    presence.setCallState(userId, 'idle', null, null, 'call-2');
    await eventually(() => {
      expect(hintPuts('103').length).toBeGreaterThanOrEqual(putsBefore + 2);
    });
    expect(hintPuts('103').at(-1)).toEqual({ deviceState: 'INUSE' });
    expect(state.presence.get(userId)?.status).toBe('busy');

    // Only the first call ending actually returns the user to idle.
    presence.setCallState(userId, 'idle', null, null, 'call-1');
    await eventually(() => {
      expect(hintPuts('103').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      expect(state.presence.get(userId)?.status).toBe('available');
    });
  });

  it('the last computed hint wins even when an earlier PUT reaches Asterisk late (§9.3)', async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e105-dabc');
    await seedExtension(db, '105', userId);
    await presence.resyncOnBoot();
    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field names (§9.3 ContactStatusChange)
      contact_info: { aor: 'e105-dabc', contact_status: 'Reachable' }
    });
    await eventually(() => {
      expect(state.presence.get(userId)?.status).toBe('available');
    });

    // The RINGING PUT travels on a slow connection: Asterisk applies it only well after the
    // idle refresh that follows it has been computed and sent.
    let ringingHeld = false;
    fakeAri.holdRequest = request => {
      const body = request.body as { deviceState?: string } | undefined;
      if (
        !ringingHeld &&
        request.path === 'deviceStates/Stasis:presence-105' &&
        body?.deviceState === 'RINGING'
      ) {
        ringingHeld = true;
        return SLOW_HINT_PUT_MS;
      }
      return 0;
    };
    presence.setCallState(userId, 'ringing', '+15557777', null, 'call-1');
    await eventually(() => {
      expect(ringingHeld).toBe(true);
    });
    presence.setCallState(userId, 'idle', null, null, 'call-1');

    // Once the late RINGING has landed, the hint Asterisk holds is still the idle one.
    await eventually(() => {
      const puts = hintPuts('105');
      expect(puts).toContainEqual({ deviceState: 'RINGING' });
      expect(puts.at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      expect(state.presence.get(userId)?.status).toBe('available');
    });
  });

  it('counts the live registered devices, which fall when a contact becomes unreachable (§7)', async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e104-dabc');
    await seedDevice(db, userId, 'e104-dxyz');

    /** One of the two devices' contacts changing state, as Asterisk reports it (§9.3). */
    function contact(aor: string, status: string): void {
      fakeAri.emit({
        type: 'ContactStatusChange',
        timestamp: nowIso(),
        application: 'zamfono',
        // eslint-disable-next-line camelcase -- ARI's own event field names (§9.3 ContactStatusChange)
        contact_info: { aor, contact_status: status }
      });
    }

    contact('e104-dabc', 'Reachable');
    contact('e104-dxyz', 'Reachable');
    await eventually(async () => {
      expect(await presence.registeredDevices()).toBe(2);
    });

    contact('e104-dabc', 'Unreachable');
    await eventually(async () => {
      expect(await presence.registeredDevices()).toBe(1);
    });
    // The event's timestamp stays on the row (§3.1) without counting the device as registered.
    await eventually(async () => {
      const rows = await db
        .selectFrom('devices')
        .select('lastRegisteredAt')
        .where('sipUsername', '=', 'e104-dabc')
        .execute();
      expect(rows[0]?.lastRegisteredAt).not.toBeNull();
    });
  });
});
