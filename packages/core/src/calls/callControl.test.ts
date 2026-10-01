import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { defaultChannel, type Logger } from '../ari/types.js';
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
import type { GroupLeg } from './groupLegs.js';
import { registerActiveBatch } from './groupPickup.js';
import { Pipeline } from './pipeline.js';

const ANY_FREE_PORT = 0;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const RING_TIMER_MS = 60_000;
const CAUSE_NORMAL = 16;
const CAUSE_CALL_REJECTED = 21;
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

/** A user at `ext` with one device, reported registered. */
async function seedUser(db: Db, fake: FakeAri, ext: string): Promise<string> {
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
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId: id,
      label: `e${ext}-a`,
      kind: 'manual',
      sipUsername: `e${ext}-a`,
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
  fake.registerEndpoint(`e${ext}-a`);
  return id;
}

describe('call control', () => {
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
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let state: StateStore;
  let closeServer: (() => Promise<void>) | null = null;

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
    state = new StateStore();
    const bus = new EventBus();
    cdr = new CdrWriter({ db, ari, cache, bus, state, now: nowIso });
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

  /** Reads the endpoint list and the config snapshot once every row a test needs exists. */
  async function devicesUp(): Promise<void> {
    cache.invalidate();
    await presence.resyncOnBoot();
  }

  afterEach(async () => {
    const close = closeServer;
    closeServer = null;
    await close?.();
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  /** An inbound call from a customer answered by `userId`'s device, bridged and opened. */
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

  function legOf(call: Call): string {
    const [leg] = call.legs.keys();
    if (leg === undefined) {
      throw new Error('no leg');
    }
    return leg;
  }

  function requested(method: string, path: string, channel?: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === method &&
        entry.path === path &&
        (channel === undefined ||
          (entry.body as { channel?: string }).channel === channel)
    );
  }

  function hungUp(channelId: string): boolean {
    return requested('DELETE', `channels/${channelId}`);
  }

  async function members(bridgeId: string): Promise<string[]> {
    const bridges = await ari.bridges.list();
    return bridges.find(bridge => bridge.id === bridgeId)?.channels ?? [];
  }

  function channelDestroyed(channelId: string): void {
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId }),
      cause: CAUSE_NORMAL
    });
  }

  function rowOf(callId: string) {
    return db
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', callId)
      .executeTakeFirst();
  }

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (error: unknown) => {
        const { status, reason } = error as { status: number; reason: string };
        return { status, reason };
      }
    );
  }

  it('holds the other party out of the bridge with the tenant hold music, and resumes it', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await devicesUp();
    const call = await answeredCall(memberId);
    const bridgeId = call.bridgeId ?? '';
    const actorUserId = memberId;

    await actions.hold(call.id, { actorUserId });
    expect(await members(bridgeId)).toEqual([legOf(call)]);
    expect(requested('POST', `channels/${call.callerChannelId}/moh`)).toBe(
      true
    );
    expect(await refusal(actions.hold(call.id, { actorUserId }))).toEqual({
      status: HTTP_CONFLICT,
      reason: 'held'
    });

    await actions.resume(call.id, { actorUserId });
    expect(requested('DELETE', `channels/${call.callerChannelId}/moh`)).toBe(
      true
    );
    expect(await members(bridgeId)).toContain(call.callerChannelId);
    expect(await refusal(actions.resume(call.id, { actorUserId }))).toEqual({
      status: HTTP_CONFLICT,
      reason: 'notHeld'
    });
    await actions.hangup(call.id, { actorUserId });
    const log = (await rowOf(call.id))?.log ?? '';
    expect(log).toContain('"event":"hold"');
    expect(log).toContain('"event":"resume"');
  });

  it('refuses to hold a call that is not bridged', async () => {
    await setUp();
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: fakeAri.addChannel({}).id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
    expect(
      await refusal(actions.hold(call.id, { actorUserId: newId() }))
    ).toEqual({ status: HTTP_CONFLICT, reason: 'notBridged' });
  });

  it('ends a held call for the held party when the one holding it hangs up, and the other way round', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await devicesUp();
    const first = await answeredCall(memberId);
    await actions.hold(first.id, { actorUserId: memberId });
    channelDestroyed(legOf(first));
    await eventually(() => {
      expect(hungUp(first.callerChannelId)).toBe(true);
    });

    const second = await answeredCall(memberId);
    await actions.hold(second.id, { actorUserId: memberId });
    channelDestroyed(second.callerChannelId);
    await eventually(() => {
      expect(hungUp(legOf(second))).toBe(true);
    });
  });

  it('hangs up the held party with the call on a REST hangup', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await devicesUp();
    const call = await answeredCall(memberId);
    await actions.hold(call.id, { actorUserId: memberId });
    await actions.hangup(call.id, { actorUserId: memberId });
    expect(hungUp(call.callerChannelId)).toBe(true);
    expect(hungUp(legOf(call))).toBe(true);
  });

  it('returns a held party to the bridge before a blind transfer moves it on', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await seedUser(db, fakeAri, '102');
    await devicesUp();
    const call = await answeredCall(memberId);
    const bridgeId = call.bridgeId ?? '';
    await actions.hold(call.id, { actorUserId: memberId });
    await actions.transfer(call.id, { target: '102', actorUserId: memberId });
    expect(
      requested('POST', `bridges/${bridgeId}/addChannel`, call.callerChannelId)
    ).toBe(true);
    expect(requested('DELETE', `channels/${call.callerChannelId}/moh`)).toBe(
      true
    );
  });

  /** A consultation of `call`'s member with the user at 102, answered and in the bridge. */
  async function answeredConsultation(
    call: Call,
    memberId: string
  ): Promise<Call> {
    const { callId } = await actions.consult(call.id, {
      target: '102',
      actorUserId: memberId
    });
    return eventually(() => {
      const consultation = [...pipeline.callByChannel.values()].find(
        candidate => candidate.id === callId
      );
      if (consultation === undefined) {
        throw new Error('the consultation is not live yet');
      }
      expect(consultation.status).toBe('answered');
      expect(consultation.bridgeId).toBe(call.bridgeId);
      // Its dial has settled: the placeholder caller channel is released.
      expect(pipeline.callByChannel.has(`consult:${callId}`)).toBe(false);
      return consultation;
    });
  }

  it('consults with the other party held, then transfers it to the consultation in the actor’s place', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    const targetId = await seedUser(db, fakeAri, '102');
    await devicesUp();
    const call = await answeredCall(memberId);
    const bridgeId = call.bridgeId ?? '';
    const actorChannel = legOf(call);
    const consultation = await answeredConsultation(call, memberId);
    const targetLeg = legOf(consultation);
    expect(await members(bridgeId)).toEqual([actorChannel, targetLeg]);
    expect(consultation.callerUserId).toBe(memberId);
    expect(consultation.parentCallId).toBeNull();
    expect(
      await refusal(
        actions.consult(call.id, { target: '102', actorUserId: memberId })
      )
    ).toEqual({ status: HTTP_CONFLICT, reason: 'consulting' });
    // The consultation's bridge is the call's: it is no conversation of its own to hand on.
    expect(
      await refusal(
        actions.transfer(consultation.id, {
          target: '102',
          actorUserId: memberId
        })
      )
    ).toEqual({ status: HTTP_CONFLICT, reason: 'notBridged' });

    await actions.attendedTransfer(call.id, {
      toCallId: consultation.id,
      actorUserId: memberId
    });
    expect(await members(bridgeId)).toEqual([targetLeg, call.callerChannelId]);
    expect(hungUp(actorChannel)).toBe(true);
    expect(consultation.parentCallId).toBe(call.id);
    expect(consultation.callerChannelId).toBe(call.callerChannelId);
    expect(pipeline.callByChannel.get(call.callerChannelId)).toBe(consultation);
    // The history's caller stays the member; the live control is the parties' still in it.
    expect(consultation.callerUserId).toBe(memberId);
    expect(state.calls.get(consultation.id)?.connectedUserIds).toEqual([
      targetId
    ]);
    const original = await eventually(async () => {
      const row = await rowOf(call.id);
      expect(row?.endedAt).not.toBeNull();
      return row;
    });
    expect(original?.status).toBe('answered');
    expect(original?.log).toContain('"event":"attendedTransfer"');

    // The transferee hanging up ends the conversation and the consultation's row.
    channelDestroyed(call.callerChannelId);
    await eventually(async () => {
      expect(hungUp(targetLeg)).toBe(true);
      const row = await rowOf(consultation.id);
      expect(row?.endedAt).not.toBeNull();
      expect(row?.parentCallId).toBe(call.id);
    });
  });

  it('leaves the actor with the party still held when the consulted party hangs up', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await seedUser(db, fakeAri, '102');
    await devicesUp();
    const call = await answeredCall(memberId);
    const consultation = await answeredConsultation(call, memberId);
    channelDestroyed(legOf(consultation));
    await eventually(async () => {
      expect((await rowOf(consultation.id))?.endedAt).not.toBeNull();
    });
    expect(hungUp(legOf(call))).toBe(false);
    expect(hungUp(call.callerChannelId)).toBe(false);
    expect(
      await refusal(
        Promise.resolve().then(() =>
          actions.attendedTransfer(call.id, {
            toCallId: consultation.id,
            actorUserId: memberId
          })
        )
      )
    ).toEqual({ status: HTTP_NOT_FOUND, reason: 'notFound' });
    await actions.resume(call.id, { actorUserId: memberId });
    expect(await members(call.bridgeId ?? '')).toContain(call.callerChannelId);
  });

  it('ends everything when the actor hangs up during a consultation', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await seedUser(db, fakeAri, '102');
    await devicesUp();
    const call = await answeredCall(memberId);
    const consultation = await answeredConsultation(call, memberId);
    channelDestroyed(legOf(call));
    await eventually(() => {
      expect(hungUp(call.callerChannelId)).toBe(true);
      expect(hungUp(legOf(consultation))).toBe(true);
    });
  });

  it('refuses a transfer to a call that is not the consultation, or not answered yet', async () => {
    await setUp();
    // The consultation below never answers.
    fakeAri.answerAfterMs = RING_TIMER_MS;
    const memberId = await seedUser(db, fakeAri, '101');
    await seedUser(db, fakeAri, '102');
    await devicesUp();
    const call = await answeredCall(memberId);
    const other = await answeredCall(memberId);
    expect(
      await refusal(
        actions.attendedTransfer(call.id, {
          toCallId: other.id,
          actorUserId: memberId
        })
      )
    ).toEqual({ status: HTTP_CONFLICT, reason: 'notConsultation' });

    const { callId } = await actions.consult(call.id, {
      target: '102',
      actorUserId: memberId
    });
    expect(
      await refusal(
        actions.attendedTransfer(call.id, {
          toCallId: callId,
          actorUserId: memberId
        })
      )
    ).toEqual({ status: HTTP_CONFLICT, reason: 'notAnswered' });
  });

  it('adds a party whose answer joins the bridge as its own row, the actor its initiator', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await seedUser(db, fakeAri, '102');
    await devicesUp();
    const call = await answeredCall(memberId);
    expect(
      await refusal(
        actions.addParty(call.id, { target: '799', actorUserId: memberId })
      )
    ).toEqual({ status: HTTP_UNPROCESSABLE, reason: 'invalidTarget' });

    const { callId } = await actions.addParty(call.id, {
      target: '102',
      actorUserId: memberId
    });
    await eventually(async () => {
      expect(await members(call.bridgeId ?? '')).toHaveLength(3);
      expect(call.threeWayInitiatorChannelId).toBe(legOf(call));
    });
    const added = [...pipeline.callByChannel.values()].find(
      candidate => candidate.id === callId
    );
    if (added === undefined) {
      throw new Error('the added leg is not live');
    }
    expect(added.parentCallId).toBe(call.id);
    expect(added.callerUserId).toBe(memberId);
    // The added party leaving ends its row and leaves the other two talking.
    channelDestroyed(legOf(added));
    await eventually(async () => {
      expect((await rowOf(callId))?.endedAt).not.toBeNull();
    });
    expect(hungUp(call.callerChannelId)).toBe(false);
  });

  it('declines the actor’s own ringing legs of a direct ring, and refuses 409 when none rings', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    const caller = fakeAri.addChannel({});
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
    call.calleeUserId = memberId;
    pipeline.registerCall(call);
    const ringing = fakeAri.addChannel({});
    call.legs.set(ringing.id, {
      channelId: ringing.id,
      kind: 'device',
      userId: memberId,
      state: 'ringing',
      endCause: null
    });
    pipeline.callByChannel.set(ringing.id, call);
    let outcome: string | null = null;
    const timer = setTimeout(() => undefined, RING_TIMER_MS);
    timer.unref();
    pipeline.pendingRing.set(call.id, {
      resolve: result => {
        outcome = result;
      },
      timer,
      existingBridgeId: null
    });
    expect(
      await refusal(
        Promise.resolve().then(() => {
          actions.decline(call.id, { actorUserId: newId() });
        })
      )
    ).toEqual({ status: HTTP_CONFLICT, reason: 'notRinging' });

    actions.decline(call.id, { actorUserId: memberId });
    expect(call.legs.get(ringing.id)?.endCause).toBe(CAUSE_CALL_REJECTED);
    // 603 is no busy: the ring settles as unanswered, for the user's noAnswer rule.
    expect(outcome).toBe('noAnswer');
    await eventually(() => {
      expect(hungUp(ringing.id)).toBe(true);
    });
  });

  it('declines a ring-group member’s legs through the batch’s own race', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: fakeAri.addChannel({}).id,
      from: '+15559999',
      to: '200',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
    const own = fakeAri.addChannel({});
    const other = fakeAri.addChannel({});
    const tracked = new Map<string, GroupLeg>([
      [
        own.id,
        {
          channelId: own.id,
          userId: memberId,
          memberKey: 'a',
          state: 'ringing'
        }
      ],
      [
        other.id,
        {
          channelId: other.id,
          userId: newId(),
          memberKey: 'b',
          state: 'ringing'
        }
      ]
    ]);
    const ended: [string, number | null][] = [];
    registerActiveBatch(pipeline, call.id, {
      tracked,
      settle: () => undefined,
      endLeg: (leg, cause) => {
        leg.state = 'ended';
        ended.push([leg.channelId, cause]);
      }
    });
    actions.decline(call.id, { actorUserId: memberId });
    expect(ended).toEqual([[own.id, CAUSE_CALL_REJECTED]]);
    expect(tracked.get(other.id)?.state).toBe('ringing');
    await eventually(() => {
      expect(hungUp(own.id)).toBe(true);
    });
    expect(hungUp(other.id)).toBe(false);
  });

  it('serves the call-control routes: 201 with the new call, 204, problems and 400', async () => {
    await setUp();
    const memberId = await seedUser(db, fakeAri, '101');
    await seedUser(db, fakeAri, '102');
    await devicesUp();
    const call = await answeredCall(memberId);
    const started = await startInternalServer(
      {
        db,
        ari,
        cache,
        state: new StateStore(),
        bus: new EventBus(),
        actions,
        presence: null,
        trunks: null
      },
      ANY_FREE_PORT
    );
    closeServer = started.close;
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${started.port}/internal/calls/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

    const consulted = await post(`${call.id}/consult`, {
      target: '102',
      actorUserId: memberId
    });
    expect(consulted.status).toBe(HTTP_CREATED);
    expect(await consulted.json()).toHaveProperty('callId');
    const held = await post(`${call.id}/hold`, { actorUserId: memberId });
    expect(held.status).toBe(HTTP_CONFLICT);
    expect(await held.json()).toMatchObject({ detail: 'held' });
    const missing = await post(`${call.id}/parties`, { actorUserId: memberId });
    expect(missing.status).toBe(HTTP_BAD_REQUEST);
    await eventually(async () => {
      const resumed = await post(`${call.id}/resume`, {
        actorUserId: memberId
      });
      expect(resumed.status).toBe(HTTP_NO_CONTENT);
    });
  });
});
