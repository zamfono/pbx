import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement, placedCallerId } from '../ari/fake.js';
import { defaultChannel, type Channel, type Logger } from '../ari/types.js';
import { CdrWriter } from '../cdr.js';
import {
  ConfigCache,
  EventBus,
  startInternalServer,
  StateStore
} from '../internal/server.js';
import { Presence } from '../presence.js';
import { eventually } from '../testing/eventually.js';
import { CallActions } from './actions.js';
import { newCall, type Call } from './call.js';
import { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import { TrunkState } from './trunkState.js';

// Any free port, never a fixed one another suite running on the same host may already hold.
const ANY_FREE_PORT = 0;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const SIP_ADDRESS_INCOMPLETE = 484;
const RING_TIMER_MS = 60_000;
const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/** A throwaway forward-target/DID chain, just to satisfy `settings.main_did_id`'s FK. */
async function seedSettings(db: Db): Promise<void> {
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
}

async function seedUser(db: Db, ext: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: `User ${ext}`,
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('extensions')
    .values({ ext, userId: id, ringGroupId: null, isParkingSlot: 0 })
    .execute();
  return id;
}

/**
 * Seeds a device and reports its AOR reachable, which §10.2 "Click-to-dial" requires before a
 * device can be rung. A test about `noRegisteredDevice` itself passes `registered: false`.
 */
async function seedDevice(
  db: Db,
  fake: FakeAri,
  userId: string,
  sipUsername: string,
  registered = true
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
  if (registered) {
    fake.registerEndpoint(sipUsername);
  }
}

/** One `ip`-mode trunk with a single host and a catch-all route (§9.4 "Outbound routing"). */
async function seedExternalRoute(
  db: Db,
  calleridHeader: 'from' | 'both' = 'from'
): Promise<string> {
  const trunkId = newId();
  await db
    .insertInto('trunks')
    .values({
      id: trunkId,
      name: 'trunk-1',
      priority: 1,
      emergency: 1,
      authMode: 'ip',
      username: null,
      passwordEnc: null,
      inboundAuth: 0,
      transport: 'udp',
      calleridHeader,
      maxChannels: null,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId,
      priority: 1,
      host: 'sip.example.com',
      port: null,
      direction: 'both'
    })
    .execute();
  await db
    .insertInto('outboundRoutes')
    .values({
      id: newId(),
      priority: 1,
      trunkId,
      calleridDidId: null,
      createdAt: nowIso()
    })
    .execute();
  return trunkId;
}

type OriginateRecord = {
  endpoint?: string;
  appArgs?: string;
  channelId?: string;
  callerId?: string;
  variables?: Record<string, string>;
};

/** Whether the core set `channelId`'s language to `language` (§9.1). */
function languageSet(
  fakeAri: FakeAri,
  channelId: string,
  language: string
): boolean {
  return fakeAri.calls.some(
    entry =>
      entry.method === 'POST' &&
      entry.path === `channels/${channelId}/variable` &&
      (entry.body as { variable?: string }).variable === 'CHANNEL(language)' &&
      (entry.body as { value?: string }).value === language
  );
}

describe('CallActions', () => {
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let cdr: CdrWriter;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let actions: CallActions;
  let closeServer: (() => Promise<void>) | null = null;

  // eslint-disable-next-line init-declarations -- assigned in setUp before each test runs
  let presence: Presence;
  // eslint-disable-next-line init-declarations -- assigned in setUp before each test runs
  let cache: ConfigCache;

  /**
   * Reads the endpoint list and the config snapshot, so every device a test seeded is reachable.
   * Called after seeding, since both sources are read once at the moment it runs.
   */
  async function devicesUp(): Promise<void> {
    cache.invalidate();
    await presence.resyncOnBoot();
  }

  async function setUp(): Promise<void> {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 5;
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
    const state = new StateStore();
    const bus = new EventBus();
    cdr = new CdrWriter({
      db,
      ari,
      cache,
      bus,
      state: new StateStore(),
      now: nowIso
    });
    // Wired as `main.ts` wires it: the ring reads registration from here, not from the rows.
    presence = new Presence({ ari, cache, state, bus, db, now: nowIso });
    pipeline = new Pipeline({
      ari,
      cache,
      state,
      bus,
      cdr,
      now: nowIso,
      db,
      trunkState: null,
      presence
    });
    actions = new CallActions(pipeline);
  }

  /** A `TrunkState` over an AMI client that never connects, enough for route selection. */
  function trunkStateForTests(): TrunkState {
    const ami = new AmiClient({
      host: '127.0.0.1',
      port: 1,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    return new TrunkState({
      ari,
      ami,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      now: nowIso
    });
  }

  async function startServer(): Promise<string> {
    const started = await startInternalServer(
      {
        db,
        ari,
        cache: new ConfigCache(db),
        state: new StateStore(),
        bus: new EventBus(),
        actions,
        presence: null,
        trunks: null
      },
      ANY_FREE_PORT
    );
    closeServer = started.close;
    return `http://127.0.0.1:${started.port}`;
  }

  /** Every channel placed, in order. A created channel's id is Asterisk's, assigned at the
   * create, so it is read from the `dial` that follows it. */
  function originates(): OriginateRecord[] {
    const dialled = fakeAri.calls
      .filter(
        entry =>
          entry.method === 'POST' && /^channels\/[^/]+\/dial$/u.test(entry.path)
      )
      .map(entry => entry.path.split('/')[1]);
    let next = 0;
    return fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(entry => {
        const body = entry.body as OriginateRecord;
        const created = entry.path === 'channels/create';
        return {
          ...body,
          channelId: body.channelId ?? (created ? dialled[next++] : undefined),
          callerId: placedCallerId(entry)
        };
      });
  }

  function hungUp(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  /** A call ringing `userId`'s devices (§10.1 step 4), its ring race pending with the pipeline. */
  function ringingCall(userId: string): Call {
    const caller = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000001',
      caller: { number: '+15559999', name: '' }
    });
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: caller.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.calleeUserId = userId;
    pipeline.registerCall(call);
    const timer = setTimeout(() => undefined, RING_TIMER_MS);
    timer.unref();
    pipeline.pendingRing.set(call.id, {
      resolve: () => undefined,
      timer,
      existingBridgeId: null
    });
    return call;
  }

  /** An answered two-party call, bridged, registered with the pipeline and opened in the CDR. */
  async function answeredCall(userId: string): Promise<Call> {
    const caller = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000001',
      caller: { number: '+15559999', name: '' }
    });
    const leg = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000002' });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, caller.id);
    await ari.bridges.addChannel(bridge.id, leg.id);
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: caller.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.calleeUserId = userId;
    call.answeredByUserId = userId;
    call.answeredAt = nowIso();
    call.status = 'answered';
    call.bridgeId = bridge.id;
    call.legs.set(leg.id, {
      channelId: leg.id,
      kind: 'device',
      userId,
      state: 'up',
      endCause: null
    });
    pipeline.registerCall(call);
    pipeline.callByChannel.set(leg.id, call);
    await cdr.open(call);
    return call;
  }

  afterEach(async () => {
    const close = closeServer;
    closeServer = null;
    await close?.();
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('rings the user devices first, then dials the extension as that device would, with the actor in the trace', async () => {
    await setUp();
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await seedDevice(db, fakeAri, callerId, 'e101-b');
    await devicesUp();
    const calleeId = await seedUser(db, '102');
    await seedDevice(db, fakeAri, calleeId, 'e102-a');
    await devicesUp();
    const actorUserId = newId();

    const result = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId,
      requestId: 'req-1'
    });
    expect(result).toHaveProperty('callId');
    const callId = 'callId' in result ? result.callId : '';
    // The originate returns as soon as the call exists; its legs, trace and release follow.
    await eventually(() => {
      const dialled = originates();
      expect(dialled.slice(0, 2).map(entry => entry.endpoint)).toEqual([
        'PJSIP/e101-a',
        'PJSIP/e101-b'
      ]);
      // Placed as any leg of the call is (§7 level `sip`: created, joined, then dialled).
      expect(dialled.slice(0, 2).map(entry => entry.appArgs)).toEqual([
        `leg,${callId}`,
        `leg,${callId}`
      ]);
      // The device that answered first carries the call; the other one is hung up.
      const deviceChannelIds = dialled
        .slice(0, 2)
        .map(entry => entry.channelId ?? '');
      expect(deviceChannelIds.filter(id => hungUp(id))).toHaveLength(1);
      // Then 102 rings exactly as it would for a dial from that device (§10.1 step 4).
      expect(dialled.at(2)).toMatchObject({
        endpoint: 'PJSIP/e102-a',
        appArgs: `leg,${callId}`
      });
      const live = [...pipeline.callByChannel.values()].find(
        call => call.id === callId
      );
      expect(live?.status).toBe('answered');
      expect(live?.callerUserId).toBe(callerId);
    });

    await actions.hangup(callId, { actorUserId });
    const row = await db
      .selectFrom('calls')
      .select(['status', 'log', 'direction', 'callerUserId'])
      .where('id', '=', callId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('answered');
    expect(row.direction).toBe('internal');
    expect(row.callerUserId).toBe(callerId);
    const lines = (row.log ?? '')
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      event: 'originate',
      actorUserId,
      requestId: 'req-1',
      target: '102'
    });
    // The REST hangup, then the end it made: the core's own, not a party's (§7).
    expect(lines.slice(-2)).toMatchObject([
      { event: 'hangup', actorUserId },
      { event: 'ended', by: 'system' }
    ]);
  });

  it('dials an external target through the user routes and trunks after the device answers', async () => {
    await setUp();
    pipeline.deps.trunkState = trunkStateForTests();
    const trunkId = await seedExternalRoute(db);
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    const result = await actions.originate({
      userId: callerId,
      target: '0301234567',
      actorUserId: callerId,
      requestId: 'req-2'
    });
    const callId = 'callId' in result ? result.callId : '';
    // The originate returns as soon as the call exists; its legs, trace and release follow.
    await eventually(() => {
      const dialled = originates();
      expect(dialled[0]).toMatchObject({ endpoint: 'PJSIP/e101-a' });
      // §9.4 "Hosts": `PJSIP/<number>@trunk-<id>` for the trunk's first host.
      expect(
        dialled
          .at(1)
          ?.endpoint?.startsWith(`PJSIP/+49301234567@trunk-${trunkId}`)
      ).toBe(true);
      expect(dialled.at(1)?.appArgs).toBe(`leg,${callId}`);
      const live = [...pipeline.callByChannel.values()].find(
        call => call.id === callId
      );
      expect(live?.direction).toBe('outbound');
      expect(live?.to).toBe('+49301234567');
    });
  });

  it('withholds the caller identity for a target dialled with the CLIR prefix, as that device would (§10.1 Outbound step 1)', async () => {
    await setUp();
    pipeline.deps.trunkState = trunkStateForTests();
    await seedExternalRoute(db, 'both');
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    const result = await actions.originate({
      userId: callerId,
      target: '#31#0301234567',
      actorUserId: callerId,
      requestId: 'req-6'
    });
    const callId = 'callId' in result ? result.callId : '';
    // The originate returns as soon as the call exists; its legs, trace and release follow.
    await eventually(() => {
      const trunkLeg = originates().at(1);
      expect(trunkLeg?.appArgs).toBe(`leg,${callId}`);
      // The real number, its presentation restricted: chan_pjsip anonymises `From` from it.
      expect(trunkLeg?.callerId).toBe('+15551234');
      expect(trunkLeg?.variables).toMatchObject({
        'CONNECTEDLINE(pres)': 'prohib'
      });
      const live = [...pipeline.callByChannel.values()].find(
        call => call.id === callId
      );
      expect(live?.to).toBe('+49301234567');
    });
  });

  it('keeps an emergency originate traced at level events whatever the tenant default (§10.1 Emergency calls)', async () => {
    await setUp();
    await db
      .updateTable('settings')
      .set({ callLogLevel: 'none' })
      .where('id', '=', 1)
      .execute();
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    const emergency = await actions.originate({
      userId: callerId,
      target: '112',
      actorUserId: callerId,
      requestId: 'req-7'
    });
    const emergencyId = 'callId' in emergency ? emergency.callId : '';
    const internal = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-8'
    });
    const internalId = 'callId' in internal ? internal.callId : '';
    // The originate returns as soon as the call exists; its legs, trace and release follow.
    await eventually(async () => {
      const rows = await db
        .selectFrom('calls')
        .select(['id', 'log'])
        .where('id', 'in', [emergencyId, internalId])
        .execute();
      const emergencyRow = rows.find(row => row.id === emergencyId);
      expect(emergencyRow?.log).toContain('"event":"originate","actorUserId"');
      expect(emergencyRow?.log).toContain('"dialAction":"emergency"');
      const internalRow = rows.find(row => row.id === internalId);
      expect(internalRow?.log ?? '').not.toContain('"event":"originate"');
    });
  });

  it('traces an originate at the originating user’s diagnostics override above a none tenant default (§7)', async () => {
    await setUp();
    await db
      .updateTable('settings')
      .set({ callLogLevel: 'none' })
      .where('id', '=', 1)
      .execute();
    const callerId = await seedUser(db, '101');
    await db
      .updateTable('users')
      .set({
        logLevel: 'events',
        logLevelExpiresAt: '2999-01-01T00:00:00.000Z'
      })
      .where('id', '=', callerId)
      .execute();
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    const result = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-9'
    });
    const callId = 'callId' in result ? result.callId : '';
    // The originate returns as soon as the call exists; its legs, trace and release follow.
    await eventually(async () => {
      const row = await db
        .selectFrom('calls')
        .select('log')
        .where('id', '=', callId)
        .executeTakeFirst();
      expect(row?.log ?? '').toContain('"event":"originate","actorUserId"');
    });
  });

  // §7 level `sip`: every device's dialog is part of the call's SIP log; `open` runs before any
  // of them exists, so each is joined once originated.
  it('joins every device it rings for an originate to the call’s SIP capture', async () => {
    await setUp();
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await seedDevice(db, fakeAri, callerId, 'e101-b');
    await devicesUp();
    const joinLeg = vi.spyOn(cdr, 'joinLeg');

    const result = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-10'
    });

    const callId = 'callId' in result ? result.callId : '';
    const rung = originates()
      .filter(entry => entry.endpoint?.startsWith('PJSIP/e101-') === true)
      .map(entry => entry.channelId);
    expect(rung).toHaveLength(2);
    expect(
      joinLeg.mock.calls.map(([call, channelId]) => [call.id, channelId])
    ).toEqual(rung.map(channelId => [callId, channelId]));
  });

  // §9.1: the answered device's channel becomes the call's caller and hears its prompts.
  it('sets the answered device channel’s language from the tenant setting', async () => {
    await setUp();
    await db.updateTable('settings').set({ language: 'de' }).execute();
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-11'
    });
    // The originate returns as soon as the call exists; its legs, trace and release follow.
    await eventually(() => {
      const rung = originates().find(
        entry => entry.endpoint?.startsWith('PJSIP/e101-') === true
      );
      expect(languageSet(fakeAri, rung?.channelId ?? '', 'de')).toBe(true);
    });
  });

  // §9.1 "every channel's language": each device leg carries it from its creation.
  it('originates every device leg with the tenant’s language', async () => {
    await setUp();
    await db.updateTable('settings').set({ language: 'de' }).execute();
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await seedDevice(db, fakeAri, callerId, 'e101-b');
    await devicesUp();

    await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-12'
    });

    const rung = originates().filter(
      entry => entry.endpoint?.startsWith('PJSIP/e101-') === true
    );
    expect(rung).toHaveLength(2);
    for (const entry of rung) {
      expect(entry.variables?.['CHANNEL(language)']).toBe('de');
    }
  });

  // §7 level `sip`: a device refusing at once (a 603 within milliseconds) is gone before a read
  // after a one-step originate could reach it; placed as any leg is, it has joined by then.
  it('joins a device that refuses at once to the SIP capture before it is dialled, and ends the call unanswered', async () => {
    await setUp();
    fakeAri.answerAfterMs = 60_000;
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();
    const trail: string[] = [];
    const joinLeg = vi.spyOn(cdr, 'joinLeg').mockImplementation((_call, id) => {
      trail.push(`join ${id}`);
      return Promise.resolve();
    });
    fakeAri.onOriginate = channel => {
      trail.push(`dial ${channel.id}`);
      fakeAri.emit({
        type: 'ChannelDestroyed',
        timestamp: nowIso(),
        application: 'zamfono',
        channel,
        cause: 21
      });
    };

    const result = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-refused'
    });

    const callId = 'callId' in result ? result.callId : '';
    const [device] = originates();
    expect(joinLeg).toHaveBeenCalledOnce();
    expect(trail).toEqual([
      `join ${device?.channelId ?? ''}`,
      `dial ${device?.channelId ?? ''}`
    ]);
    const row = await eventually(async () => {
      const written = await db
        .selectFrom('calls')
        .select(['status', 'log', 'endedAt'])
        .where('id', '=', callId)
        .executeTakeFirstOrThrow();
      expect(written.endedAt).not.toBeNull();
      return written;
    });
    expect(row.status).toBe('failed');
    expect(row.log).toContain('"event":"declined"');
    expect(row.log).toContain('"event":"originate","result":"unanswered"');
  });

  it('ends a click-to-dial unanswered at once when its phone cannot be placed', async () => {
    await setUp();
    fakeAri.failDial = { status: 409 };
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    const result = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-unplaced'
    });

    const callId = 'callId' in result ? result.callId : '';
    const row = await eventually(async () => {
      const written = await db
        .selectFrom('calls')
        .select(['status', 'log', 'endedAt'])
        .where('id', '=', callId)
        .executeTakeFirstOrThrow();
      expect(written.endedAt).not.toBeNull();
      return written;
    });
    expect(row.status).toBe('failed');
    expect(row.log).toContain('"cause":"placementFailed"');
    expect(row.log).toContain('"event":"originate","result":"unanswered"');
  });

  it('answers 409 noRegisteredDevice when the user has devices but none is registered', async () => {
    await setUp();
    const userId = await seedUser(db, '101');
    // A configured device that has never REGISTERed: §10.2 "Click-to-dial" turns on whether a
    // device can be rung, which a `devices` row alone does not settle.
    await seedDevice(db, fakeAri, userId, 'e101-a', false);
    await devicesUp();
    const actorUserId = newId();

    const result = await actions.originate({
      userId,
      target: '102',
      actorUserId,
      requestId: 'req-dnd'
    });

    expect(result).toEqual({ error: 'noRegisteredDevice' });
  });

  it('answers 409 noRegisteredDevice over HTTP for a user without a device and records the attempt', async () => {
    await setUp();
    const userId = await seedUser(db, '101');
    const actorUserId = newId();
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/internal/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        target: '102',
        actorUserId,
        requestId: 'req-3'
      })
    });
    expect(response.status).toBe(HTTP_CONFLICT);
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json'
    );
    await expect(response.json()).resolves.toEqual({
      type: 'about:blank',
      title: 'no registered device',
      status: HTTP_CONFLICT,
      detail: 'noRegisteredDevice'
    });
    expect(originates()).toHaveLength(0);

    const row = await db
      .selectFrom('calls')
      .select(['status', 'log', 'endedAt'])
      .where('callerUserId', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.endedAt).not.toBeNull();
    expect(row.log).toContain(`"actorUserId":"${actorUserId}"`);
    expect(row.log).toContain('"result":"noRegisteredDevice"');
  });

  it('ends the call on a REST hangup, with the actor in the trace, and answers 404 for an unknown call', async () => {
    await setUp();
    const userId = await seedUser(db, '101');
    const call = await answeredCall(userId);
    const actorUserId = newId();
    const baseUrl = await startServer();

    const response = await fetch(
      `${baseUrl}/internal/calls/${call.id}/hangup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorUserId })
      }
    );
    expect(response.status).toBe(HTTP_NO_CONTENT);
    expect(hungUp(call.callerChannelId)).toBe(true);
    for (const leg of call.legs.values()) {
      expect(hungUp(leg.channelId)).toBe(true);
    }
    expect(pipeline.callByChannel.size).toBe(0);
    const row = await db
      .selectFrom('calls')
      .select(['status', 'log', 'endedAt', 'answeredByUserId'])
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('answered');
    expect(row.endedAt).not.toBeNull();
    expect(row.answeredByUserId).toBe(userId);
    expect(row.log).toContain(
      `{"callId":"${call.id}","event":"hangup","actorUserId":"${actorUserId}"}`
    );

    const missing = await fetch(`${baseUrl}/internal/calls/${newId()}/hangup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorUserId })
    });
    expect(missing.status).toBe(HTTP_NOT_FOUND);
  });

  it('releases an incomplete address with 484 once the device answers, as a device dial would (§10.1 Outbound step 4)', async () => {
    await setUp();
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    const result = await actions.originate({
      userId: callerId,
      target: '301234567',
      actorUserId: callerId,
      requestId: 'req-5'
    });
    const callId = 'callId' in result ? result.callId : '';
    // The originate returns as soon as the call exists; its legs, trace and release follow.
    await eventually(async () => {
      const deviceChannelId = originates()[0]?.channelId ?? '';
      expect(
        fakeAri.calls.some(
          entry =>
            entry.method === 'DELETE' &&
            entry.path === `channels/${deviceChannelId}` &&
            entry.qs ===
              `reason_code=${sipToHangupCause(SIP_ADDRESS_INCOMPLETE)}`
        )
      ).toBe(true);
      const row = await db
        .selectFrom('calls')
        .select(['status', 'log', 'endedAt'])
        .where('id', '=', callId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('failed');
      expect(row.endedAt).not.toBeNull();
      expect(row.log).toContain(
        `"event":"release","code":${SIP_ADDRESS_INCOMPLETE}`
      );
    });
  });

  it('picks up a ringing call by ringing the picker devices and dialling *8<ext> with the one that answers, and refuses 409 notRinging otherwise', async () => {
    await setUp();
    const dials: { args: unknown; channelId: string }[] = [];
    pipeline.setOutboundHandler(ev => {
      dials.push({ args: ev.args, channelId: (ev.channel as Channel).id });
      return Promise.resolve();
    });
    const calleeId = await seedUser(db, '101');
    const pickerId = await seedUser(db, '102');
    await seedDevice(db, fakeAri, pickerId, 'e102-a');
    await seedDevice(db, fakeAri, pickerId, 'e102-b');
    await devicesUp();
    const actorUserId = newId();
    const ringing = ringingCall(calleeId);

    await actions.pickup(ringing.id, { userId: pickerId, actorUserId });
    const dialled = originates();
    expect(dialled.map(entry => entry.endpoint)).toEqual([
      'PJSIP/e102-a',
      'PJSIP/e102-b'
    ]);
    // Both ring in a race of their own; the first to answer dials `*8101` as the feature code would.
    const [first, second] = dialled.map(entry => entry.appArgs);
    expect(first).toMatch(/^leg,/u);
    expect(second).toBe(first);
    await eventually(() => {
      expect(dials).toEqual([
        { args: ['outbound', '*8101'], channelId: dialled[0]?.channelId }
      ]);
      expect(hungUp(dialled[1]?.channelId ?? '')).toBe(true);
    });

    const answered = await answeredCall(calleeId);
    await expect(
      actions.pickup(answered.id, { userId: pickerId, actorUserId })
    ).rejects.toMatchObject({ status: HTTP_CONFLICT, reason: 'notRinging' });
    const nobodyId = await seedUser(db, '103');
    await expect(
      actions.pickup(ringing.id, { userId: nobodyId, actorUserId })
    ).rejects.toMatchObject({
      status: HTTP_CONFLICT,
      reason: 'noRegisteredDevice'
    });
    clearTimeout(pipeline.pendingRing.get(ringing.id)?.timer);
    ringing.status = 'missed';
    await cdr.finish(ringing);
    const row = await db
      .selectFrom('calls')
      .select('log')
      .where('id', '=', ringing.id)
      .executeTakeFirstOrThrow();
    expect(row.log).toContain(
      `"event":"pickup","userId":"${pickerId}","actorUserId":"${actorUserId}","ext":"101"`
    );
  });

  // §7 level `sip`: the picker's devices ring for the picked-up call, so their dialogs are its.
  it('joins every device it rings for a pickup to the picked-up call’s SIP capture', async () => {
    await setUp();
    const calleeId = await seedUser(db, '101');
    const pickerId = await seedUser(db, '102');
    await seedDevice(db, fakeAri, pickerId, 'e102-a');
    await seedDevice(db, fakeAri, pickerId, 'e102-b');
    await devicesUp();
    const ringing = ringingCall(calleeId);
    const joinLeg = vi.spyOn(cdr, 'joinLeg');

    await actions.pickup(ringing.id, {
      userId: pickerId,
      actorUserId: newId()
    });

    const rung = originates().map(entry => entry.channelId);
    expect(rung).toHaveLength(2);
    expect(
      joinLeg.mock.calls.map(([call, channelId]) => [call.id, channelId])
    ).toEqual(rung.map(channelId => [ringing.id, channelId]));
    clearTimeout(pipeline.pendingRing.get(ringing.id)?.timer);
  });

  // §7: the pickup's own ring runs on a call that is never written, so its trace lands in the
  // picked-up call's, where a pickup that rang nobody is explained.
  it('writes the trace of a pickup ring that never rang into the picked-up call, each line attributed to it', async () => {
    await setUp();
    fakeAri.failOriginate = { status: 500 };
    const calleeId = await seedUser(db, '101');
    const pickerId = await seedUser(db, '102');
    await seedDevice(db, fakeAri, pickerId, 'e102-a');
    await devicesUp();
    const ringing = ringingCall(calleeId);

    await actions.pickup(ringing.id, {
      userId: pickerId,
      actorUserId: pickerId
    });
    // The ring's outcome settles in promise callbacks after the placement; let them run.
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    clearTimeout(pipeline.pendingRing.get(ringing.id)?.timer);
    ringing.status = 'missed';
    await cdr.finish(ringing);

    const row = await db
      .selectFrom('calls')
      .select('log')
      .where('id', '=', ringing.id)
      .executeTakeFirstOrThrow();
    const lines = (row.log ?? '')
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({
        callId: ringing.id,
        event: 'pickupRing',
        step: 'rungDevice',
        userId: pickerId,
        cause: 'placementFailed'
      })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'pickup',
        userId: pickerId,
        result: 'unanswered'
      })
    );
    // Nothing of the ring reads as the picked-up call's own trace.
    expect(lines.some(line => line.event === 'rungDevice')).toBe(false);
  });

  function hintStates(ext: string): (string | undefined)[] {
    return fakeAri.calls
      .filter(
        entry =>
          entry.method === 'PUT' &&
          entry.path === `deviceStates/Stasis:presence-${ext}`
      )
      .map(entry => (entry.body as { deviceState?: string }).deviceState);
  }

  function destroyed(channelId: string): void {
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId })
    });
  }

  it('shows the user ringing while an originate rings their devices, and not once none answered (§9.3)', async () => {
    await setUp();
    fakeAri.answerAfterMs = 60_000;
    const callerId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, callerId, 'e101-a');
    await devicesUp();

    await actions.originate({
      userId: callerId,
      target: '+4930123456',
      actorUserId: callerId,
      requestId: 'req-ring'
    });
    await eventually(() => {
      expect(hintStates('101').at(-1)).toBe('RINGING');
    });

    for (const entry of originates()) {
      destroyed(entry.channelId ?? '');
    }
    await eventually(() => {
      expect(hintStates('101').at(-1)).toBe('NOT_INUSE');
    });
  });

  it('shows the picker ringing while a pickup rings their devices, and not once none answered (§9.3)', async () => {
    await setUp();
    fakeAri.answerAfterMs = 60_000;
    const calleeId = await seedUser(db, '101');
    const pickerId = await seedUser(db, '102');
    await seedDevice(db, fakeAri, pickerId, 'e102-a');
    await devicesUp();
    const ringing = ringingCall(calleeId);

    await actions.pickup(ringing.id, {
      userId: pickerId,
      actorUserId: pickerId
    });
    await eventually(() => {
      expect(hintStates('102').at(-1)).toBe('RINGING');
    });

    for (const entry of originates()) {
      destroyed(entry.channelId ?? '');
    }
    await eventually(() => {
      expect(hintStates('102').at(-1)).toBe('NOT_INUSE');
    });
    clearTimeout(pipeline.pendingRing.get(ringing.id)?.timer);
  });

  it('serves the originate route with 201 and the MWI trigger with 204', async () => {
    await setUp();
    const userId = await seedUser(db, '101');
    await seedDevice(db, fakeAri, userId, 'e101-a');
    await devicesUp();
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/internal/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        target: '102',
        actorUserId: userId,
        requestId: 'req-4'
      })
    });
    expect(response.status).toBe(HTTP_CREATED);
    const body = (await response.json()) as { callId?: string };
    expect(typeof body.callId).toBe('string');

    const mwi = await fetch(`${baseUrl}/internal/mwi/user:${userId}`, {
      method: 'POST'
    });
    expect(mwi.status).toBe(HTTP_NO_CONTENT);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'PUT' && entry.path === `mailboxes/user:${userId}`
      )
    ).toBe(true);

    // A client that percent-encodes the segment's colon names the same mailbox.
    const encoded = await fetch(
      `${baseUrl}/internal/mwi/${encodeURIComponent(`user:${userId}`)}`,
      { method: 'POST' }
    );
    expect(encoded.status).toBe(HTTP_NO_CONTENT);
    const unknown = await fetch(`${baseUrl}/internal/mwi/nobody`, {
      method: 'POST'
    });
    expect(unknown.status).toBe(HTTP_NOT_FOUND);
    // The mailbox name is interpolated into the ARI path, so only `<kind>:<uuid>` reaches it.
    const traversal = await fetch(
      `${baseUrl}/internal/mwi/user:%2F..%2F..%2Fasterisk%2Fmodules%2Fres_pjsip`,
      { method: 'POST' }
    );
    expect(traversal.status).toBe(HTTP_NOT_FOUND);
    expect(
      fakeAri.calls.some(entry => entry.path.startsWith('asterisk/'))
    ).toBe(false);
  });
});
