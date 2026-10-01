import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement, placedCallerId } from '../ari/fake.js';
import type { Logger } from '../ari/types.js';
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
import { TrunkState } from './trunkState.js';

// The live-call actions `api`'s parking, voicemail-deposit and per-call CLIR operations proxy to
// (§10.2 "Call parking", §9.3 `*97<ext>`, §9.4 "Anonymous calls (CLIR)"), each through the code
// path the phone's own feature code takes.

const ANY_FREE_PORT = 0;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

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

async function seedSlot(db: Db, ext: string): Promise<void> {
  await db
    .insertInto('extensions')
    .values({ ext, userId: null, ringGroupId: null, isParkingSlot: 1 })
    .execute();
}

async function seedDevice(
  db: Db,
  fake: FakeAri,
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
  fake.registerEndpoint(sipUsername);
}

/** One `ip`-mode trunk that may carry emergency calls, with a catch-all route (§9.4). */
async function seedExternalRoute(db: Db): Promise<void> {
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
      calleridHeader: 'both',
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
}

function traceOf(call: Call): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('CallActions: parking, voicemail deposit and per-call CLIR', () => {
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
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let presence: Presence;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let cache: ConfigCache;
  let closeServer: (() => Promise<void>) | null = null;

  async function setUp(): Promise<void> {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 5;
    // A deposit waits for Asterisk to end its recording (§10.2 "Voicemail").
    fakeAri.recordingFinishedAfterMs = 5;
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
    presence = new Presence({ ari, cache, state, bus, db, now: nowIso });
    pipeline = new Pipeline({
      ari,
      cache,
      state,
      bus,
      cdr,
      now: nowIso,
      db,
      apiClient: { mail: () => Promise.resolve() },
      trunkState: null,
      presence
    });
    actions = new CallActions(pipeline);
  }

  async function devicesUp(): Promise<void> {
    cache.invalidate();
    await presence.resyncOnBoot();
  }

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

  function hungUp(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  /** An inbound call from `from` that `userId` answered, bridged, as `winLeg` leaves one. */
  async function answeredCall(
    userId: string,
    from = '+15559999'
  ): Promise<Call> {
    const caller = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000001',
      caller: { number: from, name: '' }
    });
    const leg = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000002' });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, caller.id);
    await ari.bridges.addChannel(bridge.id, leg.id);
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: caller.id,
      from,
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

  function legChannelOf(call: Call): string {
    return [...call.legs.keys()][0] ?? '';
  }

  afterEach(async () => {
    const close = closeServer;
    closeServer = null;
    await close?.();
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('parks the other party as *70 does, returning the slot, and lists it for everyone', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, '101');
    const call = await answeredCall(anna);
    const actorUserId = newId();

    const result = await actions.park(call.id, { userId: anna, actorUserId });

    expect(result).toEqual({ slot: '701' });
    // The parker's own channel leaves the call, as after `*70` (§10.2 "Call parking").
    expect(hungUp(legChannelOf(call))).toBe(true);
    const holds = fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(holds.at(-1)?.body).toMatchObject({ type: 'holding' });
    const { parked } = await actions.parked();
    expect(parked).toEqual([
      {
        slot: '701',
        callId: call.id,
        caller: '+15559999',
        parkedAt: expect.any(String) as string,
        parkedByUserId: anna
      }
    ]);
    expect(traceOf(call)).toContainEqual(
      expect.objectContaining({
        event: 'parked',
        by: anna,
        ext: '701',
        actorUserId
      })
    );
  });

  it('lists a parked caller who withheld their number without one (§9.4)', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, '101');
    const call = await answeredCall(anna, 'anonymous');

    await actions.park(call.id, { userId: anna, actorUserId: anna });

    const { parked } = await actions.parked();
    expect(parked.map(entry => entry.caller)).toEqual([null]);
  });

  it('refuses a park by a user not in the call, of an unbridged call, or with every slot taken', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, '101');
    const ben = await seedUser(db, '102');
    const first = await answeredCall(anna);
    await expect(
      actions.park(first.id, { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 409, reason: 'notInCall' });

    const lone = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: fakeAri.addChannel({}).id,
      from: '102',
      to: '103',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    lone.callerUserId = ben;
    pipeline.registerCall(lone);
    await expect(
      actions.park(lone.id, { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 409, reason: 'notBridged' });

    await actions.park(first.id, { userId: anna, actorUserId: anna });
    const second = await answeredCall(ben);
    await expect(
      actions.park(second.id, { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 409, reason: 'noFreeSlot' });
    // Refused, the call stays where it was.
    expect(hungUp(legChannelOf(second))).toBe(false);
    await expect(
      actions.park(newId(), { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a click-to-dial to the slot retrieves the parked call, as dialling it from the phone does', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, '101');
    const ben = await seedUser(db, '102');
    await seedDevice(db, fakeAri, ben, 'e102-a');
    await devicesUp();
    const call = await answeredCall(anna);
    await actions.park(call.id, { userId: anna, actorUserId: anna });

    const outcome = await actions.originate({
      userId: ben,
      target: '701',
      actorUserId: ben,
      requestId: 'req-1'
    });

    expect(outcome).toHaveProperty('callId');
    await eventually(async () => {
      expect(call.answeredByUserId).toBe(ben);
      const benLeg = [...call.legs.values()].find(leg => leg.userId === ben);
      expect(benLeg?.state).toBe('up');
      expect((await actions.parked()).parked).toEqual([]);
    });
  });

  it('transfers to voicemail through *97<ext>, depositing in that mailbox without ringing it', async () => {
    await setUp();
    const anna = await seedUser(db, '101');
    const ben = await seedUser(db, '102');
    await seedDevice(db, fakeAri, ben, 'e102-a');
    await devicesUp();
    const call = await answeredCall(anna);

    await actions.transfer(call.id, {
      target: '102',
      actorUserId: anna,
      voicemail: true
    });

    await eventually(async () => {
      const child = await db
        .selectFrom('calls')
        .select(['status', 'log', 'direction'])
        .where('parentCallId', '=', call.id)
        .executeTakeFirstOrThrow();
      expect(child.status).toBe('voicemail');
      expect(child.direction).toBe('inbound');
      expect(child.log).toContain('"dialed":"*97102"');
      const messages = await db
        .selectFrom('voicemails')
        .select('mailboxUserId')
        .execute();
      expect(messages).toEqual([{ mailboxUserId: ben }]);
    });
    // Nobody's phone rang: no device of 102's was placed.
    expect(
      fakeAri.calls.some(
        entry =>
          isPlacement(entry) &&
          (entry.body as { endpoint?: string }).endpoint === 'PJSIP/e102-a'
      )
    ).toBe(false);
  });

  it('refuses a voicemail transfer to an extension with no mailbox with 422, leaving the call as it was', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, '101');
    const call = await answeredCall(anna);

    for (const target of ['999', '701']) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked in turn
      await expect(
        actions.transfer(call.id, {
          target,
          actorUserId: anna,
          voicemail: true
        })
      ).rejects.toMatchObject({ status: 422, reason: 'noMailbox' });
    }
    expect(hungUp(legChannelOf(call))).toBe(false);
  });

  it('withholds the number of a click-to-dial with clir, as #31# would, but never an emergency call’s', async () => {
    await setUp();
    pipeline.deps.trunkState = trunkStateForTests();
    await seedExternalRoute(db);
    const anna = await seedUser(db, '101');
    await seedDevice(db, fakeAri, anna, 'e101-a');
    await devicesUp();

    type Placed = {
      endpoint?: string;
      callerId?: string;
      variables?: Record<string, string>;
    };
    const placed = (): Placed[] =>
      fakeAri.calls
        .filter(entry => isPlacement(entry))
        .map(entry => ({
          ...(entry.body as {
            endpoint?: string;
            variables?: Record<string, string>;
          }),
          callerId: placedCallerId(entry)
        }));
    const placedTo = (prefix: string): Placed | undefined =>
      placed().find(entry => entry.endpoint?.startsWith(prefix));

    await actions.originate({
      userId: anna,
      target: '0301234567',
      actorUserId: anna,
      requestId: 'req-clir',
      clir: true
    });
    await eventually(() => {
      const trunkLeg = placedTo('PJSIP/+49301234567@trunk-');
      expect(trunkLeg?.callerId).toBe('+15551234');
      expect(trunkLeg?.variables).toMatchObject({
        'CONNECTEDLINE(pres)': 'prohib'
      });
    });

    await actions.originate({
      userId: anna,
      target: '112',
      actorUserId: anna,
      requestId: 'req-emergency',
      clir: true
    });
    await eventually(() => {
      const emergencyLeg = placedTo('PJSIP/112@trunk-');
      expect(emergencyLeg).toBeDefined();
      expect(emergencyLeg?.variables?.['CONNECTEDLINE(pres)']).toBe(undefined);
    });
  });

  it('serves the park route with 200 and the slot, the parking read, and refuses a malformed flag', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, '101');
    const call = await answeredCall(anna);
    const baseUrl = await startServer();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

    const flagged = await post(`/internal/calls/${call.id}/transfer`, {
      target: '102',
      actorUserId: anna,
      voicemail: 'yes'
    });
    expect(flagged.status).toBe(HTTP_BAD_REQUEST);
    const parkedResponse = await post(`/internal/calls/${call.id}/park`, {
      userId: anna,
      actorUserId: anna
    });
    expect(parkedResponse.status).toBe(HTTP_OK);
    expect(await parkedResponse.json()).toEqual({ slot: '701' });
    const list = await fetch(`${baseUrl}/internal/parking`);
    expect(list.status).toBe(HTTP_OK);
    const body = (await list.json()) as { parked: { callId: string }[] };
    expect(body.parked.map(entry => entry.callId)).toEqual([call.id]);
    const unknown = await post(`/internal/calls/${newId()}/park`, {
      userId: anna,
      actorUserId: anna
    });
    expect(unknown.status).toBe(HTTP_NOT_FOUND);
    expect(await unknown.json()).toMatchObject({ detail: 'notFound' });
  });
});
