import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement } from '../ari/fake.js';
import type { Logger } from '../ari/types.js';
import type { LogLevel } from '../callLog.js';
import { CdrWriter } from '../cdr.js';
import { ConfigCache, EventBus, StateStore } from '../internal/server.js';
import { eventually } from '../testing/eventually.js';
import { newCall, type Call } from './call.js';
import { channelOf } from './callLookup.js';
import { closeCall } from './liveCall.js';
import { handleOutbound } from './outbound.js';
import { Pipeline } from './pipeline.js';
import { Recorder } from './recording.js';
import { followTransfers } from './referTransfers.js';
import { transferCall, userOfChannel } from './transfers.js';
import { TrunkState } from './trunkState.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// How long a check that something does NOT happen gives the flow to do it anyway.
const SETTLE_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

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

/** A trunk plus an outbound route restricted to `userId`, so only their calls match it (§9.4). */
async function seedTrunkWithRoute(db: Db, userId: string): Promise<string> {
  const trunkId = newId();
  await db
    .insertInto('trunks')
    .values({
      id: trunkId,
      name: `trunk-${trunkId}`,
      priority: 1,
      emergency: 1,
      authMode: 'registration',
      username: 'u',
      passwordEnc: Buffer.from('secret'),
      inboundAuth: 0,
      transport: 'udp',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId,
      priority: 1,
      host: 'sip.example.net',
      port: null,
      direction: 'both'
    })
    .execute();
  const routeId = newId();
  await db
    .insertInto('outboundRoutes')
    .values({ id: routeId, priority: 1, trunkId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('outboundRouteUsers')
    .values({ routeId, userId })
    .execute();
  return trunkId;
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
  return id;
}

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

describe('transfers', () => {
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
    const cache = new ConfigCache(db);
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
    const ami = new AmiClient({
      host: '127.0.0.1',
      port: 1,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    const trunkState = new TrunkState({
      ari,
      ami,
      cache,
      state,
      bus,
      now: nowIso
    });
    pipeline = new Pipeline({
      ari,
      cache,
      state,
      bus,
      cdr,
      now: nowIso,
      db,
      trunkState,
      presence: null
    });
    // The real `outbound,<exten>` path, the one a transferee re-enters through `from-users`.
    pipeline.setOutboundHandler(ev => handleOutbound(pipeline, trunkState, ev));
    followTransfers(pipeline);
  }

  /** An answered inbound call from `+15559999`, bridged with `userId`'s device leg. */
  async function answeredCall(
    userId: string,
    legName: string
  ): Promise<{ call: Call; callerId: string; legId: string }> {
    const caller = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000001',
      caller: { number: '+15559999', name: '' }
    });
    const leg = fakeAri.addChannel({ name: legName });
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
    return { call, callerId: caller.id, legId: leg.id };
  }

  function hungUp(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  /**
   * Waits until the core has followed a `REFER` transfer: hanging up the transferrer's channel,
   * left with nobody, is the last thing either kind of transfer does (`blindTransfer.ts`,
   * `attendedTransfer.ts`).
   */
  function transferFollowed(transferrerChannelId: string): Promise<void> {
    return eventually(() => {
      expect(hungUp(transferrerChannelId)).toBe(true);
    });
  }

  function originatedEndpoints(): { endpoint?: string; appArgs?: string }[] {
    return fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(entry => entry.body as { endpoint?: string; appArgs?: string });
  }

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('follows a blind transfer: the original call closes and the re-entering transferee becomes a child call', async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    await seedUser(db, '102');
    const { call, callerId, legId } = await answeredCall(
      transferrerId,
      'PJSIP/e101-a-00000002'
    );
    // The company number the caller dialled (§11.2 `calls.did_id`).
    call.didId = (
      await db.selectFrom('dids').select('id').executeTakeFirstOrThrow()
    ).id;

    fakeAri.emit({
      type: 'BridgeBlindTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: legId, name: 'PJSIP/e101-a-00000002' },
      transferee: { id: callerId, name: 'PJSIP/trunk-1-00000001' },
      exten: '102',
      context: 'from-users',
      result: 'Success',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      is_external: false
    });

    // Asterisk executes the REFER itself; the core closes the call and then ends the
    // transferrer's participation, whose channel is left with nobody, and leaves the transferee
    // to the onward call.
    await eventually(() => {
      expect(hungUp(legId)).toBe(true);
    });
    const original = await db
      .selectFrom('calls')
      .select(['status', 'endedAt', 'log'])
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(original.status).toBe('answered');
    expect(original.endedAt).not.toBeNull();
    expect(original.log).toContain('"event":"blindTransfer"');
    expect(pipeline.callByChannel.has(callerId)).toBe(false);
    expect(hungUp(callerId)).toBe(false);

    // The transferee re-enters Stasis through `from-users` (§9.2), dialling the transfer target.
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '102'],
      channel: {
        id: callerId,
        name: 'PJSIP/trunk-1-00000001',
        state: 'Up',
        caller: { number: '+15559999', name: '' },
        connected: { number: '', name: '' },
        dialplan: { context: 'from-users', exten: '102' }
      }
    });

    // The onward call rings the target once it has read the config and found the extension.
    const child = await eventually(() => {
      const onward = pipeline.callByChannel.get(callerId);
      expect(onward).toBeDefined();
      expect(originatedEndpoints()).not.toHaveLength(0);
      return onward;
    });
    expect(child?.id).not.toBe(call.id);
    expect(child?.parentCallId).toBe(call.id);
    // The same row a transfer over the API gives the original inbound caller: still inbound,
    // through the parent's DID, and without a calling user.
    expect(child?.direction).toBe('inbound');
    expect(child?.didId).toBe(call.didId);
    expect(child?.callerUserId).toBeNull();
    expect(originatedEndpoints().at(-1)).toMatchObject({
      endpoint: 'PJSIP/e102-a',
      appArgs: `leg,${child?.id ?? ''}`
    });
    if (child !== undefined) {
      await closeCall(pipeline, child, 'answered', true);
    }
    const childRow = await db
      .selectFrom('calls')
      .select(['parentCallId', 'status', 'direction', 'didId'])
      .where('id', '=', child?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(childRow.parentCallId).toBe(call.id);
    expect(childRow.status).toBe('answered');
    expect(childRow.direction).toBe('inbound');
    expect(childRow.didId).toBe(call.didId);
  });

  it("routes a blind transfer to an external number as the transferrer's call (§10.1)", async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    // The transferrer's own outbound route and presented number; the transferee is an outside
    // caller with neither.
    const trunkId = await seedTrunkWithRoute(db, transferrerId);
    const { callerId, legId } = await answeredCall(
      transferrerId,
      'PJSIP/e101-a-00000002'
    );

    fakeAri.emit({
      type: 'BridgeBlindTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: legId, name: 'PJSIP/e101-a-00000002' },
      transferee: { id: callerId, name: 'PJSIP/trunk-1-00000001' },
      exten: '+15557777',
      context: 'from-users',
      result: 'Success',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      is_external: false
    });
    await transferFollowed(legId);

    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '+15557777'],
      channel: {
        id: callerId,
        name: 'PJSIP/trunk-1-00000001',
        state: 'Up',
        caller: { number: '+15559999', name: '' },
        connected: { number: '', name: '' },
        dialplan: { context: 'from-users', exten: '+15557777' }
      }
    });

    // §9.4 picks the route from the caller's identity. The transferee matches no route of their
    // own, so a dial over the transferrer's trunk is the only outcome that can be theirs.
    await eventually(() => {
      const dialled = fakeAri.calls.filter(entry => isPlacement(entry));
      expect(
        dialled.some(entry =>
          (entry.body as { endpoint?: string }).endpoint?.includes(
            `trunk-${trunkId}`
          )
        )
      ).toBe(true);
    });
  });

  it("names the transferrer by the channel that sent the REFER, not by the call's answerer (§10.1)", async () => {
    await setUp();
    const answererId = await seedUser(db, '101');
    const transferrerId = await seedUser(db, '102');
    // Only the transferrer, the internal caller, has a route; the answerer, whom the old
    // identity named, has none, and neither does the transferee they are.
    const trunkId = await seedTrunkWithRoute(db, transferrerId);
    const { call, callerId, legId } = await answeredCall(
      answererId,
      'PJSIP/e101-a-00000002'
    );
    call.direction = 'internal';
    call.callerUserId = transferrerId;

    // 102, the caller, transfers 101 to an external number.
    fakeAri.emit({
      type: 'BridgeBlindTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: callerId, name: 'PJSIP/e102-a-00000001' },
      transferee: { id: legId, name: 'PJSIP/e101-a-00000002' },
      exten: '+15557777',
      context: 'from-users',
      result: 'Success',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      is_external: false
    });
    await transferFollowed(callerId);

    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '+15557777'],
      channel: {
        id: legId,
        name: 'PJSIP/e101-a-00000002',
        state: 'Up',
        caller: { number: '101', name: '' },
        connected: { number: '', name: '' },
        dialplan: { context: 'from-users', exten: '+15557777' }
      }
    });

    await eventually(() => {
      expect(
        originatedEndpoints().some(entry =>
          entry.endpoint?.includes(`trunk-${trunkId}`)
        )
      ).toBe(true);
      // The onward call is the transferee's own: dialled as the transferrer, not made by them.
      const child = pipeline.callByChannel.get(legId);
      expect(child?.parentCallId).toBe(call.id);
      expect(child?.callerUserId).toBe(answererId);
    });
  });

  it('follows a blind transfer out of a Stasis bridge, where a Local pair dials the target for the transferee', async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    const trunkId = await seedTrunkWithRoute(db, transferrerId);
    const { call, callerId, legId } = await answeredCall(
      transferrerId,
      'PJSIP/e101-a-00000002'
    );
    const bridgeId = call.bridgeId ?? '';
    const localOne = fakeAri.addChannel({
      name: 'Local/+15557777@from-users-00000001;1'
    });
    const localTwo = fakeAri.addChannel({
      name: 'Local/+15557777@from-users-00000001;2'
    });

    // Asterisk reports the dialling half's StasisStart before the transfer that created it.
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '+15557777'],
      channel: {
        id: localTwo.id,
        name: localTwo.name,
        state: 'Ring',
        caller: { number: '', name: '' },
        connected: { number: '', name: '' },
        dialplan: { context: 'from-users', exten: '+15557777' }
      }
    });
    fakeAri.emit({
      type: 'BridgeBlindTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: legId, name: 'PJSIP/e101-a-00000002' },
      transferee: { id: callerId, name: 'PJSIP/trunk-1-00000001' },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      replace_channel: { id: localOne.id, name: localOne.name },
      exten: '+15557777',
      context: 'from-users',
      result: 'Success',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      is_external: true
    });

    // The dialling half's call is the transferee's onward call, dialled as the transferrer.
    await eventually(() => {
      const child = pipeline.callByChannel.get(localTwo.id);
      expect(child?.parentCallId).toBe(call.id);
      expect(child?.from).toBe('+15559999');
      expect(child?.callerUserId).toBeNull();
      expect(
        originatedEndpoints().some(entry =>
          entry.endpoint?.includes(`trunk-${trunkId}`)
        )
      ).toBe(true);
      expect(hungUp(legId)).toBe(true);
    });
    expect(hungUp(callerId)).toBe(false);

    // The transferee hanging up ends their Local line, and with it the onward call.
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: callerId, name: 'PJSIP/trunk-1-00000001' },
      cause: 16
    });
    await eventually(() => {
      expect(hungUp(localOne.id)).toBe(true);
      expect(
        fakeAri.calls.some(
          entry =>
            entry.method === 'DELETE' && entry.path === `bridges/${bridgeId}`
        )
      ).toBe(true);
    });
  });

  it('hangs up the transferee once the onward call through its Local pair ends', async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    const { callerId, legId } = await answeredCall(
      transferrerId,
      'PJSIP/e101-a-00000002'
    );
    const localOne = fakeAri.addChannel({
      name: 'Local/102@from-users-00000002;1'
    });

    fakeAri.emit({
      type: 'BridgeBlindTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: legId, name: 'PJSIP/e101-a-00000002' },
      transferee: { id: callerId, name: 'PJSIP/trunk-1-00000001' },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      replace_channel: { id: localOne.id, name: localOne.name },
      exten: '102',
      context: 'from-users',
      result: 'Success',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      is_external: true
    });
    await transferFollowed(legId);
    // The onward call ended: its Local pair goes with it, the first half included.
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: localOne.id, name: localOne.name },
      cause: 16
    });

    await eventually(() => {
      expect(hungUp(callerId)).toBe(true);
    });
  });

  it('blind-transfers the other party over the API into a child call routed to the target', async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    await seedUser(db, '102');
    const { call, callerId, legId } = await answeredCall(
      transferrerId,
      'PJSIP/e101-a-00000002'
    );
    const bridgeId = call.bridgeId ?? '';

    const child = await transferCall(pipeline, call, {
      target: '102',
      actorUserId: transferrerId
    });
    // The child call rings the target in the background, which answers `answerAfterMs` later.
    await eventually(() => {
      expect(originatedEndpoints().at(-1)).toMatchObject({
        endpoint: 'PJSIP/e102-a',
        appArgs: `leg,${child?.id ?? ''}`
      });
      expect(child?.status).toBe('answered');
    });

    expect(child).not.toBeNull();
    expect(child?.parentCallId).toBe(call.id);
    expect(child?.callerChannelId).toBe(callerId);
    expect(child?.direction).toBe('inbound');
    expect(child?.from).toBe('+15559999');
    expect(hungUp(legId)).toBe(true);
    expect(hungUp(callerId)).toBe(false);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === `bridges/${bridgeId}/removeChannel` &&
          (entry.body as { channel?: string }).channel === callerId
      )
    ).toBe(true);
    expect(originatedEndpoints().at(-1)).toMatchObject({
      endpoint: 'PJSIP/e102-a',
      appArgs: `leg,${child?.id ?? ''}`
    });
    expect(child?.status).toBe('answered');
    const original = await db
      .selectFrom('calls')
      .select(['status', 'endedAt', 'log'])
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(original.status).toBe('answered');
    expect(original.endedAt).not.toBeNull();
    expect(original.log).toContain(`"actorUserId":"${transferrerId}"`);
    const childRow = await db
      .selectFrom('calls')
      .select(['parentCallId'])
      .where('id', '=', child?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(childRow.parentCallId).toBe(call.id);
  });

  // §9.1: the transferee may be a leg the core originated, which never passed an entry of its own.
  it('sets the transferee channel’s language from the tenant setting', async () => {
    await setUp();
    await db.updateTable('settings').set({ language: 'de' }).execute();
    const transferrerId = await seedUser(db, '101');
    await seedUser(db, '102');
    const { call, callerId } = await answeredCall(
      transferrerId,
      'PJSIP/e101-a-00000002'
    );

    await transferCall(pipeline, call, {
      target: '102',
      actorUserId: transferrerId
    });

    await eventually(() => {
      expect(languageSet(fakeAri, callerId, 'de')).toBe(true);
    });
  });

  it('keeps a transfer to an emergency number traced at level events whatever the tenant default (§10.1 Emergency calls)', async () => {
    await setUp();
    await db
      .updateTable('settings')
      .set({ callLogLevel: 'none' })
      .where('id', '=', 1)
      .execute();
    const transferrerId = await seedUser(db, '101');
    const { call } = await answeredCall(transferrerId, 'PJSIP/e101-a-00000002');

    const child = await transferCall(pipeline, call, {
      target: '112',
      actorUserId: transferrerId
    });

    expect(child?.log.level).toBe('events');
    // The row carries the trace once the child's dial, in the background, has ended it.
    await eventually(async () => {
      const row = await db
        .selectFrom('calls')
        .select('log')
        .where('id', '=', child?.id ?? '')
        .executeTakeFirstOrThrow();
      expect(row.log).toContain('"dialAction":"emergency"');
    });
  });

  it('returns null for a transfer of a call that is not bridged', async () => {
    await setUp();
    const userId = await seedUser(db, '101');
    const { call } = await answeredCall(userId, 'PJSIP/e101-a-00000002');
    call.bridgeId = null;
    await expect(
      transferCall(pipeline, call, { target: '102', actorUserId: userId })
    ).resolves.toBeNull();
  });

  /** 101's consultation call to 102: 101's second channel is its caller, 102's device its leg. */
  async function consultationCall(
    transferrerId: string,
    targetId: string,
    logLevel: LogLevel = 'events'
  ): Promise<{ consultation: Call; secondId: string; targetLegId: string }> {
    const second = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000003' });
    const targetLeg = fakeAri.addChannel({ name: 'PJSIP/e102-a-00000004' });
    const bridge2 = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge2.id, second.id);
    await ari.bridges.addChannel(bridge2.id, targetLeg.id);
    const consultation = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: second.id,
      from: '101',
      to: '102',
      startedAt: nowIso(),
      logLevel,
      callLogMaxBytes: 1_048_576
    });
    consultation.callerUserId = transferrerId;
    consultation.calleeUserId = targetId;
    consultation.answeredByUserId = targetId;
    consultation.status = 'answered';
    consultation.bridgeId = bridge2.id;
    consultation.legs.set(targetLeg.id, {
      channelId: targetLeg.id,
      kind: 'device',
      userId: targetId,
      state: 'up',
      endCause: null
    });
    pipeline.registerCall(consultation);
    pipeline.callByChannel.set(targetLeg.id, consultation);
    await cdr.open(consultation);
    return { consultation, secondId: second.id, targetLegId: targetLeg.id };
  }

  function destroyed(channelId: string): void {
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: channelId, name: '' },
      cause: 16
    });
  }

  async function endedAt(callId: string): Promise<string | null> {
    const row = await db
      .selectFrom('calls')
      .select('endedAt')
      .where('id', '=', callId)
      .executeTakeFirstOrThrow();
    return row.endedAt;
  }

  it('follows an attended transfer: the consultation call carries on with the transferee as a child of the original', async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    const targetId = await seedUser(db, '102');
    const original = await answeredCall(transferrerId, 'PJSIP/e101-a-00000002');
    const { consultation, secondId } = await consultationCall(
      transferrerId,
      targetId
    );
    const bridge2 = consultation.bridgeId ?? '';
    // Asterisk merged the two bridges into the consultation's.
    await ari.bridges.removeChannel(bridge2, secondId);
    await ari.bridges.addChannel(bridge2, original.callerId);

    fakeAri.emit({
      type: 'BridgeAttendedTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_first_leg: { id: original.legId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_second_leg: { id: secondId },
      transferee: { id: original.callerId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_type: 'bridge',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_bridge: bridge2,
      result: 'Success'
    });
    await transferFollowed(original.legId);

    const originalRow = await db
      .selectFrom('calls')
      .select(['endedAt', 'log'])
      .where('id', '=', original.call.id)
      .executeTakeFirstOrThrow();
    expect(originalRow.endedAt).not.toBeNull();
    expect(originalRow.log).toContain('"event":"attendedTransfer"');
    expect(consultation.parentCallId).toBe(original.call.id);
    expect(consultation.bridgeId).toBe(bridge2);
    expect(pipeline.callByChannel.get(original.callerId)).toBe(consultation);
    expect(pipeline.callByChannel.has(secondId)).toBe(false);
    expect(pipeline.callByChannel.has(original.legId)).toBe(false);
    // The transferee holds the place the transferrer had in the consultation.
    expect(consultation.callerChannelId).toBe(original.callerId);
    // The transferrer's first channel is left with nobody.
    expect(hungUp(original.legId)).toBe(true);
    // The history's caller is still the transferrer, who no longer controls the call: their
    // channel left it (§10.3 "Live calls").
    expect(consultation.callerUserId).toBe(transferrerId);
    expect(userOfChannel(consultation, original.callerId)).toBeNull();
    expect(channelOf(consultation, transferrerId)).toBeNull();
  });

  it('carries the consultation on past the transferrer leaving Stasis, and closes it once the transferee hangs up', async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    const targetId = await seedUser(db, '102');
    const original = await answeredCall(transferrerId, 'PJSIP/e101-a-00000002');
    const { consultation, secondId, targetLegId } = await consultationCall(
      transferrerId,
      targetId
    );
    const bridge2 = consultation.bridgeId ?? '';
    await ari.bridges.removeChannel(bridge2, secondId);
    await ari.bridges.addChannel(bridge2, original.callerId);
    // Asterisk takes the transferrer's second channel out of Stasis before it reports the
    // transfer; the consultation must not end with it.
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: secondId, name: 'PJSIP/e101-a-00000003' }
    });
    fakeAri.emit({
      type: 'BridgeAttendedTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_first_leg: { id: original.legId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_second_leg: { id: secondId },
      transferee: { id: original.callerId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_type: 'bridge',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_bridge: bridge2,
      result: 'Success'
    });
    await transferFollowed(original.legId);
    // Asterisk ends the transferrer's second channel itself; that ends nothing else.
    destroyed(secondId);
    await sleep(SETTLE_MS);
    expect(await endedAt(consultation.id)).toBeNull();

    destroyed(original.callerId);

    await eventually(async () => {
      expect(hungUp(targetLegId)).toBe(true);
      expect(await endedAt(consultation.id)).not.toBeNull();
      expect(pipeline.callByChannel.has(original.callerId)).toBe(false);
    });
  });

  it("records the transferee's own participation in the consultation row once it carries the call on (§10.1, §10.2)", async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    const targetId = await seedUser(db, '102');
    const transfereeId = await seedUser(db, '103');
    await db
      .updateTable('users')
      .set({ recordCalls: 1 })
      .where('id', '=', transfereeId)
      .execute();
    const recorder = new Recorder({
      ari,
      cache: new ConfigCache(db),
      db,
      mediaDir: '/media',
      mix: () => Promise.resolve(0),
      log: noopLogger,
      now: nowIso
    });
    pipeline.deps.recorder = recorder;
    // 103 called 101, recorded on 103's flag; 101 consults 102 and transfers 103 to them.
    const original = await answeredCall(transferrerId, 'PJSIP/e101-a-00000002');
    original.call.callerUserId = transfereeId;
    await recorder.onCallerUp(original.call);
    const { consultation, secondId } = await consultationCall(
      transferrerId,
      targetId
    );
    const bridge2 = consultation.bridgeId ?? '';
    await ari.bridges.removeChannel(bridge2, secondId);
    await ari.bridges.addChannel(bridge2, original.callerId);

    fakeAri.emit({
      type: 'BridgeAttendedTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_first_leg: { id: original.legId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_second_leg: { id: secondId },
      transferee: { id: original.callerId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_type: 'bridge',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_bridge: bridge2,
      result: 'Success'
    });
    // Two participations of two snoops each, the original call's first; each participation's
    // end listens for its `RecordingFinished` before it hangs its snoop pair up.
    const recordRequests = (): typeof fakeAri.calls =>
      fakeAri.calls.filter(
        entry => entry.method === 'POST' && entry.path.endsWith('/record')
      );
    const snoopHungUp = (entry: (typeof fakeAri.calls)[number]): boolean =>
      hungUp(entry.path.slice('channels/'.length, -'/record'.length));
    // The transferee's participation in the consultation has started once the original call,
    // which closes only after it, has ended its own.
    await eventually(() => {
      const records = recordRequests();
      expect(records).toHaveLength(4);
      expect(records.slice(0, 2).every(snoopHungUp)).toBe(true);
    });
    destroyed(original.callerId);
    const records = await eventually(() => {
      const all = recordRequests();
      expect(all.every(snoopHungUp)).toBe(true);
      return all;
    });
    // Asterisk ends each snoop recording as its snoop channel is hung up.
    for (const entry of records) {
      fakeAri.emit({
        type: 'RecordingFinished',
        timestamp: nowIso(),
        application: 'zamfono',
        recording: { name: (entry.body as { name?: string }).name }
      });
    }

    // Two participations of 103: the original call up to the transfer, the consultation after.
    await eventually(async () => {
      const rows = await db
        .selectFrom('recordings')
        .select(['callId', 'userId'])
        .execute();
      expect(rows).toEqual(
        expect.arrayContaining([
          { callId: original.call.id, userId: transfereeId },
          { callId: consultation.id, userId: transfereeId }
        ])
      );
      expect(rows).toHaveLength(2);
    });
  });

  it("writes the consultation's call_qos for every leg it had, each from its own hangup (§7)", async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    const targetId = await seedUser(db, '102');
    const original = await answeredCall(transferrerId, 'PJSIP/e101-a-00000002');
    const { consultation, secondId, targetLegId } = await consultationCall(
      transferrerId,
      targetId,
      'qos'
    );
    // Each channel's hangup leaves its own jitter on it: 1, 2 and 3 ms.
    fakeAri.rtpQos.set(secondId, { txjitter: 0.001, rxjitter: 0 });
    fakeAri.rtpQos.set(original.callerId, { txjitter: 0.002, rxjitter: 0 });
    fakeAri.rtpQos.set(targetLegId, { txjitter: 0.003, rxjitter: 0 });
    const hangupRequest = (channelId: string): void => {
      fakeAri.emit({
        type: 'ChannelHangupRequest',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: { id: channelId, name: '' }
      });
    };
    const bridge2 = consultation.bridgeId ?? '';
    await ari.bridges.removeChannel(bridge2, secondId);
    await ari.bridges.addChannel(bridge2, original.callerId);
    // Asterisk hangs the transferrer's second channel up as it reports the transfer.
    hangupRequest(secondId);
    fakeAri.emit({
      type: 'BridgeAttendedTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_first_leg: { id: original.legId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_second_leg: { id: secondId },
      transferee: { id: original.callerId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_type: 'bridge',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_bridge: bridge2,
      result: 'Success'
    });
    await transferFollowed(original.legId);
    destroyed(secondId);

    // The transferee hangs up, which ends the consultation, and the core hangs up the target.
    hangupRequest(original.callerId);
    destroyed(original.callerId);
    await eventually(async () => {
      expect(await endedAt(consultation.id)).not.toBeNull();
    });
    destroyed(targetLegId);

    const byChannel = await eventually(async () => {
      const rows = await db
        .selectFrom('callQos')
        .select(['channelId', 'role', 'jitterMs'])
        .where('callId', '=', consultation.id)
        .execute();
      const written = new Map(rows.map(row => [row.channelId, row]));
      expect([...written.keys()].sort()).toEqual(
        [secondId, targetLegId, original.callerId].sort()
      );
      return written;
    });
    // Each channel's row is what its own hangup left, whenever it left the conversation.
    expect(byChannel.get(secondId)?.jitterMs).toBe(1);
    expect(byChannel.get(original.callerId)?.jitterMs).toBe(2);
    expect(byChannel.get(targetLegId)?.jitterMs).toBe(3);
  });

  it('collapses the Local link of an attended transfer between two Stasis bridges into one bridge', async () => {
    await setUp();
    const transferrerId = await seedUser(db, '101');
    const targetId = await seedUser(db, '102');
    const original = await answeredCall(transferrerId, 'PJSIP/e101-a-00000002');
    const { consultation, secondId, targetLegId } = await consultationCall(
      transferrerId,
      targetId
    );
    const bridge1 = original.call.bridgeId ?? '';
    const bridge2 = consultation.bridgeId ?? '';
    // Asterisk swapped a Local pair in for the transferrer's two channels.
    await ari.bridges.removeChannel(bridge2, secondId);
    const localOne = fakeAri.addChannel({
      name: 'Local/_attended@transfer-00000000;1'
    });
    const localTwo = fakeAri.addChannel({
      name: 'Local/_attended@transfer-00000000;2'
    });

    fakeAri.emit({
      type: 'BridgeAttendedTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_first_leg: { id: original.legId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_second_leg: { id: secondId },
      transferee: { id: original.callerId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transfer_target: { id: targetLegId },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_first_leg_bridge: { id: bridge1 },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      transferer_second_leg_bridge: { id: bridge2 },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_type: 'link',
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_link_first_leg: { id: localOne.id },
      // eslint-disable-next-line camelcase -- ARI's own event field name
      destination_link_second_leg: { id: localTwo.id },
      result: 'Success'
    });
    await transferFollowed(original.legId);

    const posted = (path: string): string[] =>
      fakeAri.calls
        .filter(entry => entry.method === 'POST' && entry.path === path)
        .map(entry => (entry.body as { channel?: string }).channel ?? '');
    expect(posted(`bridges/${bridge1}/removeChannel`)).toContain(
      original.callerId
    );
    expect(posted(`bridges/${bridge2}/addChannel`)).toContain(
      original.callerId
    );
    expect(hungUp(localOne.id)).toBe(true);
    expect(hungUp(localTwo.id)).toBe(true);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' && entry.path === `bridges/${bridge1}`
      )
    ).toBe(true);

    // The target hanging up now ends the conversation for the transferee too.
    destroyed(targetLegId);
    await eventually(() => {
      expect(hungUp(original.callerId)).toBe(true);
    });
    destroyed(original.callerId);
    await eventually(async () => {
      expect(await endedAt(consultation.id)).not.toBeNull();
    });
  });
});
