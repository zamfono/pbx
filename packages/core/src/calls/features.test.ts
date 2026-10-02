import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { isPlacement } from '../ari/fakeDial.js';
import {
  defaultChannel,
  type AriEvent,
  type Channel,
  type Logger
} from '../ari/types.js';
import { CdrWriter } from '../cdr.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { Presence } from '../presence.js';
import { defaultPrompt } from '../prompts.js';
import {
  eventually,
  nextSubscription,
  requestTo
} from '../testing/eventually.js';
import { newCall, type Call, type Leg } from './call.js';
import { channelOf, otherChannelIn } from './callLookup.js';
import { callUp, liveView } from './callState.js';
import { handleFeature } from './features.js';
import { handleOutbound } from './outbound.js';
import { retrieveParkedCall } from './parkingRetrieval.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { sipToHangupCause } from './releaseCause.js';
import { ringGroup } from './ringGroup.js';
import { ringUser } from './ringUser.js';
import { TrunkState } from './trunkState.js';
import type { MailSender } from './voicemail.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// How long a check that something does NOT happen gives the flow to do it anyway.
const SETTLE_MS = 50;
// A parking slot's timeout in the ring-back tests (`setUp`'s `parkingTimeoutS`), and how long past
// it the ring-back's outcome is waited for.
const PARKING_TIMEOUT_S = 1;
const RINGBACK_WAIT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function traceEvents(call: Call): string[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as { event?: string }).event ?? '');
}

/**
 * Waits until the ring-group batch tracks its member's leg: a leg is traced once its originate
 * returned and the race holds it, so a pickup from here on finds the group ringing.
 */
function memberRinging(call: Call): Promise<void> {
  return eventually(() => {
    expect(traceEvents(call)).toContain('ringGroupMember');
  });
}

/** A throwaway forward-target/DID chain, just to satisfy `settings.main_did_id`'s FK. */
async function seedSettings(db: Db, parkingTimeoutS?: number): Promise<void> {
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
      emergencyNumbersJson: '["112"]',
      parkingTimeoutS
    })
    .execute();
}

async function seedUser(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Test User',
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

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
  opts: { userId?: string; ringGroupId?: string; isParkingSlot?: boolean }
): Promise<void> {
  await db
    .insertInto('extensions')
    .values({
      ext,
      userId: opts.userId ?? null,
      ringGroupId: opts.ringGroupId ?? null,
      isParkingSlot: opts.isParkingSlot === true ? 1 : 0
    })
    .execute();
}

function stubMailSender(): MailSender {
  return { mail: () => Promise.resolve() };
}

/** One `ip`-mode trunk with a single host and a catch-all route, for `*5<number>`'s external
 * target (§10.1 Outbound step 6). */
async function seedExternalRoute(db: Db): Promise<string> {
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
      calleridHeader: 'from',
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

/** A `ring_groups` row plus its single member (§10.1 step 5), for `*8<ext>` on a group member. */
async function seedRingGroup(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({
      id,
      name: `Group ${id}`,
      strategy: 'simultaneous',
      allowReject: 1,
      mailboxEnabled: 0,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedMember(
  db: Db,
  groupId: string,
  position: number,
  userId: string
): Promise<void> {
  await db
    .insertInto('ringGroupMembers')
    .values({ groupId, position, userId, userGroupId: null })
    .execute();
}

async function seedVoicemail(
  db: Db,
  mailboxUserId: string,
  filename: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('voicemails')
    .values({
      id,
      mailboxUserId,
      mailboxRingGroupId: null,
      caller: '+15559999',
      filename,
      durationS: 12,
      createdAt: nowIso(),
      read: 0
    })
    .execute();
  return id;
}

function newInternalCall(channelId: string, from: string, to: string): Call {
  return newCall({
    id: newId(),
    direction: 'internal',
    callerChannelId: channelId,
    from,
    to,
    startedAt: nowIso(),
    logLevel: 'events',
    callLogMaxBytes: 1_048_576
  });
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

describe('features', () => {
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
  let presence: Presence;

  async function setUp(parkingTimeoutS?: number): Promise<void> {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db, parkingTimeoutS);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 60_000;
    // A deposit reached from a feature waits for Asterisk to end its recording (§10.2).
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
    const cache = new ConfigCache(db);
    const state = new StateStore();
    const bus = new EventBus();
    cdr = new CdrWriter({
      log: noopLogger,
      db,
      ari,
      cache,
      bus,
      state: new StateStore(),
      now: nowIso
    });
    presence = new Presence({
      log: noopLogger,
      ari,
      cache,
      state,
      bus,
      db,
      now: nowIso
    });
    // Wired the way `main.ts` does it, so the ring/answer/end points reach `presence`; a test
    // that dials externally sets `trunkState` itself.
    const deps: PipelineDeps = {
      ari,
      cache,
      state,
      bus,
      cdr,
      now: nowIso,
      db,
      apiClient: stubMailSender(),
      trunkState: null,
      presence
    };
    pipeline = new Pipeline(deps);
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
      log: noopLogger,
      ari,
      ami,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      now: nowIso
    });
  }

  /** Marks `sipUsername` registered through the same ARI event `main.ts`'s `Presence` consumes. */
  async function registerDevice(sipUsername: string): Promise<void> {
    const { userId } = await db
      .selectFrom('devices')
      .select('userId')
      .where('sipUsername', '=', sipUsername)
      .executeTakeFirstOrThrow();
    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field names (§9.3 ContactStatusChange)
      contact_info: { aor: sipUsername, contact_status: 'Reachable' }
    });
    // `Presence` handles the event off the WebSocket; its refresh PUTs the hint and then logs the
    // user's first status past `offline` (§10.2 "Presence and BLF").
    await eventually(async () => {
      expect(presence.isRegistered(sipUsername)).toBe(true);
      const rows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', userId)
        .where('status', '!=', 'offline')
        .execute();
      expect(rows).not.toHaveLength(0);
    });
  }

  function hintPutsFor(ext: string): { deviceState?: string }[] {
    return fakeAri.calls
      .filter(
        entry =>
          entry.method === 'PUT' &&
          entry.path === `deviceStates/Stasis:presence-${ext}`
      )
      .map(entry => entry.body as { deviceState?: string });
  }

  function channelDestroyed(channelId: string): void {
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId }),
      cause: 16
    });
  }

  type RowView = {
    status: string;
    answeredAt: string | null;
    endedAt: string | null;
  };

  function callsRow(callId: string): Promise<RowView> {
    return db
      .selectFrom('calls')
      .select(['status', 'answeredAt', 'endedAt'])
      .where('id', '=', callId)
      .executeTakeFirstOrThrow();
  }

  /** The `*5` added party hanging up, which ends their leg's own `calls` row (§10.2). */
  async function addedPartyLeaves(addPartyCall: Call): Promise<void> {
    for (const leg of addPartyCall.legs.values()) {
      if (leg.state === 'up') {
        channelDestroyed(leg.channelId);
      }
    }
    await eventually(async () => {
      expect((await callsRow(addPartyCall.id)).endedAt).not.toBeNull();
    });
  }

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('*8101 while 101 rings answers the picker and records them as answerer', async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const targetChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const target = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: targetChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    target.calleeUserId = targetUserId;
    pipeline.registerCall(target);
    await cdr.open(target);
    const deviceChannel = fakeAri.addChannel({});
    target.legs.set(deviceChannel.id, {
      channelId: deviceChannel.id,
      kind: 'device',
      userId: targetUserId,
      state: 'ringing',
      endCause: null
    });
    pipeline.callByChannel.set(deviceChannel.id, target);
    const ringTimer = setTimeout(() => undefined, 60_000);
    pipeline.pendingRing.set(target.id, {
      resolve: () => undefined,
      timer: ringTimer,
      existingBridgeId: null
    });

    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e102', '*8101');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);
    await cdr.open(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    expect(target.answeredByUserId).toBe(pickerUserId);
    expect(target.status).toBe('answered');
    const bridgeCreates = fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(bridgeCreates).toHaveLength(1);
    const deviceHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${deviceChannel.id}`
    );
    expect(deviceHangup).toBe(true);
    const pickerHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${pickerChannel.id}`
    );
    expect(pickerHangup).toBe(false);
  });

  /** An inbound call ringing `targetUserId`'s one device through the single-user ring race, as
   * `ringUser` leaves it, for `*8<ext>` to pick up. */
  async function ringingDirectCall(targetUserId: string): Promise<Call> {
    const targetChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const target = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: targetChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    target.calleeUserId = targetUserId;
    pipeline.registerCall(target);
    await cdr.open(target);
    const deviceChannel = fakeAri.addChannel({});
    target.legs.set(deviceChannel.id, {
      channelId: deviceChannel.id,
      kind: 'device',
      userId: targetUserId,
      state: 'ringing',
      endCause: null
    });
    pipeline.callByChannel.set(deviceChannel.id, target);
    const ringTimer = setTimeout(() => undefined, 60_000);
    pipeline.pendingRing.set(target.id, {
      resolve: () => undefined,
      timer: ringTimer,
      existingBridgeId: null
    });
    return target;
  }

  async function pickerCallFor(ext: string): Promise<Call> {
    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e102', `*8${ext}`);
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);
    await cdr.open(pickerCall);
    return pickerCall;
  }

  // §7 level `sip`: the picker's dialog is the picked-up call's answered leg from here on, not the
  // `*8` dial's, which closes at once.
  it("*8101: joins the picker's dialog to the picked-up call's SIP capture", async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const target = await ringingDirectCall(targetUserId);
    const pickerCall = await pickerCallFor('101');
    fakeAri.channelVariables.set(
      `${pickerCall.callerChannelId}:CHANNEL(pjsip,call-id)`,
      'picker-dialog@10.0.0.2'
    );

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    // The join reads the picker channel's Call-ID off ARI first.
    await eventually(() => {
      expect(cdr.knowsCallId('picker-dialog@10.0.0.2')).toBe(true);
    });
    target.status = 'answered';
    await cdr.finish(target);
    expect(cdr.knowsCallId('picker-dialog@10.0.0.2')).toBe(false);
  });

  it("*8101: the pickup is recorded, shown up and traced as the call's one answer, like every answer", async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const target = await ringingDirectCall(targetUserId);
    const pickerCall = await pickerCallFor('101');
    const callers: Call[] = [];
    const legs: Leg[] = [];
    const recorder: ParticipationRecorder = {
      onCallerUp: call => {
        callers.push(call);
        return Promise.resolve();
      },
      onLegUp: (_call, leg) => {
        legs.push(leg);
        return Promise.resolve();
      },
      onTransfereeUp: () => Promise.resolve(),
      onCallerEnded: () => Promise.resolve(),
      onLegEnded: () => Promise.resolve()
    };
    pipeline.deps.recorder = recorder;

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    // §10.2 "Recording semantics": the picker's participation is evaluated on its own flags.
    expect(callers).toEqual([target]);
    expect(legs.map(leg => [leg.channelId, leg.userId])).toEqual([
      [pickerCall.callerChannelId, pickerCall.callerUserId]
    ]);
    // §10.6 and `GET /internal/state`: the picked-up call is live and up.
    expect(pipeline.deps.state.calls.get(target.id)?.state).toBe('up');
    const answered = (target.log.finish().log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event?: string; userId?: string })
      .filter(line => line.event === 'answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]?.userId).toBe(pickerCall.callerUserId);
  });

  it('*8101 loses to an answer already in flight: the call keeps its answerer and the picker is refused', async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const target = await ringingDirectCall(targetUserId);
    // The ring race's own device answer claimed the call and is still bridging (`winLeg`).
    target.answeredAt = nowIso();
    target.answeredByUserId = targetUserId;
    target.status = 'answered';
    const pickerCall = await pickerCallFor('101');

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    expect(target.answeredByUserId).toBe(targetUserId);
    expect(pipeline.pendingRing.has(target.id)).toBe(true);
    const bridgeCreates = fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(bridgeCreates).toHaveLength(0);
    const refused = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${pickerCall.callerChannelId}` &&
        entry.qs === `reason_code=${sipToHangupCause(404)}`
    );
    expect(refused).toBe(true);
  });

  it('*8101: the picker hanging up ends the picked-up call for its caller (§10.1 "Pickup")', async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const targetChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const target = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: targetChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    target.calleeUserId = targetUserId;
    pipeline.registerCall(target);
    await cdr.open(target);
    const deviceChannel = fakeAri.addChannel({});
    target.legs.set(deviceChannel.id, {
      channelId: deviceChannel.id,
      kind: 'device',
      userId: targetUserId,
      state: 'ringing',
      endCause: null
    });
    pipeline.callByChannel.set(deviceChannel.id, target);
    const ringTimer = setTimeout(() => undefined, 60_000);
    pipeline.pendingRing.set(target.id, {
      resolve: () => undefined,
      timer: ringTimer,
      existingBridgeId: null
    });
    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e102', '*8101');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);
    await cdr.open(pickerCall);
    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: pickerChannel.id }),
      cause: 16
    });

    await eventually(() => {
      const callerHangup = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${targetChannel.id}`
      );
      expect(callerHangup).toBe(true);
    });
  });

  it('*90 sets dnd and hint BUSY', async () => {
    await setUp();
    const userId = await seedUser(db);
    await seedExtension(db, '201', { userId });
    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e201', '*90');
    call.callerUserId = userId;
    pipeline.registerCall(call);
    await cdr.open(call);

    await handleFeature(pipeline, presence, call, 'dndOn', '');

    const row = await db
      .selectFrom('users')
      .select('dnd')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.dnd).toBe(1);
    const hint = fakeAri.calls
      .filter(
        entry =>
          entry.method === 'PUT' &&
          entry.path === 'deviceStates/Stasis:presence-201'
      )
      .at(-1);
    expect(hint?.body).toEqual({ deviceState: 'BUSY' });
  });

  it('*90 dialled from a registered device sets dnd, hint BUSY and presence dnd', async () => {
    await setUp();
    pipeline.deps.trunkState = trunkStateForTests();
    const userId = await seedUser(db);
    await seedExtension(db, '201', { userId });
    await seedDevice(db, userId, 'e201-dabc');
    await presence.resyncOnBoot();
    await registerDevice('e201-dabc');
    expect(hintPutsFor('201').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });

    // The real dial path: `handleOutbound` resolves `*90` from the warm config snapshot.
    const channel = fakeAri.addChannel({
      name: 'PJSIP/e201-dabc-00000001',
      caller: { number: '201', name: '' }
    });
    await handleOutbound(pipeline, {
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '*90'],
      channel
    });

    const row = await db
      .selectFrom('users')
      .select('dnd')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.dnd).toBe(1);
    expect(hintPutsFor('201').at(-1)).toEqual({ deviceState: 'BUSY' });
    // §10.2 "Presence and BLF", §10.6: the status is `dnd`, appended to `presence_log`.
    const statuses = await db
      .selectFrom('presenceLog')
      .select('status')
      .where('userId', '=', userId)
      .orderBy('since', 'asc')
      .execute();
    expect(statuses.map(entry => entry.status)).toEqual([
      'offline',
      'available',
      'dnd'
    ]);
  });

  it('add-party creates a child calls row', async () => {
    await setUp();
    const userA = await seedUser(db);
    const userC = await seedUser(db);
    // add-party dials a colleague, whose device must be reachable to ring (§10.1 step 4).
    fakeAri.registerEndpoint('e300-dabc');
    await seedDevice(db, userC, 'e300-dabc');
    await seedExtension(db, '300', { userId: userC });

    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(userAChannel.id, {
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5300');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);

    // addParty waits for the originated leg to answer before bridging it (§10.2), so the
    // default 60 s `answerAfterMs` (set for tests that must never auto-answer) would time this
    // race out; this test wants userC's device to answer promptly instead.
    fakeAri.answerAfterMs = 10;
    // Reads the endpoint list and the config snapshot, so it runs once every row exists.
    await presence.resyncOnBoot();
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '300');
    await addedPartyLeaves(addPartyCall);

    const row = await db
      .selectFrom('calls')
      .select(['parentCallId', 'toUri'])
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    expect(row.parentCallId).toBe(activeCall.id);
    // §11.2 `calls.to_uri`: the pipeline's view of the target, the extension, not `*5300`.
    expect(row.toUri).toBe('300');
    // Not just *an* addChannel call on the right bridge (both original parties already produced
    // one during setup above): the *new* party's own channel, once it actually answered.
    const joinedNewParty = fakeAri.calls.some(entry => {
      if (
        entry.method !== 'POST' ||
        entry.path !== `bridges/${bridge.id}/addChannel`
      ) {
        return false;
      }
      const channel = (entry.body as { channel?: string }).channel;
      return (
        channel !== undefined &&
        channel !== customerChannel.id &&
        channel !== userAChannel.id
      );
    });
    expect(joinedNewParty).toBe(true);
  });

  it('*5 to an external number dials it through the normal outbound resolution', async () => {
    await setUp();
    await seedExternalRoute(db);
    pipeline.deps.trunkState = trunkStateForTests();

    const userA = await seedUser(db);
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(userAChannel.id, {
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(
      addPartyChannel.id,
      'e100',
      '*5+15551234567'
    );
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);

    fakeAri.answerAfterMs = 10;
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15551234567'
    );

    // The external leg went out `PJSIP/<number>@trunk-<id>` — the trunk, not any local extension.
    const dialedTrunk = fakeAri.calls.some(entry => {
      if (!isPlacement(entry)) {
        return false;
      }
      const endpoint = (entry.body as { endpoint?: string }).endpoint;
      return endpoint?.includes('@trunk-') === true;
    });
    expect(dialedTrunk).toBe(true);
    const joinedExternalParty = fakeAri.calls.some(entry => {
      if (
        entry.method !== 'POST' ||
        entry.path !== `bridges/${bridge.id}/addChannel`
      ) {
        return false;
      }
      const channel = (entry.body as { channel?: string }).channel;
      return (
        channel !== undefined &&
        channel !== customerChannel.id &&
        channel !== userAChannel.id
      );
    });
    expect(joinedExternalParty).toBe(true);
  });

  /** 100 (userA) and a customer bridged, plus userA's `*5<number>` feature dial, not yet run. */
  async function externalAddParty(): Promise<{
    activeCall: Call;
    addPartyCall: Call;
    bridgeId: string;
    userA: string;
  }> {
    await seedExternalRoute(db);
    pipeline.deps.trunkState = trunkStateForTests();
    const userA = await seedUser(db);
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.status = 'answered';
    activeCall.legs.set(userAChannel.id, {
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    pipeline.callByChannel.set(userAChannel.id, activeCall);
    await cdr.open(activeCall);
    const addPartyCall = newInternalCall(
      fakeAri.addChannel({}).id,
      'e100',
      '*5+15551234567'
    );
    addPartyCall.callerUserId = userA;
    addPartyCall.parentCallId = activeCall.id;
    pipeline.registerCall(addPartyCall);
    fakeAri.answerAfterMs = 10;
    await cdr.open(addPartyCall);
    return { activeCall, addPartyCall, bridgeId: bridge.id, userA };
  }

  it('*5 to an external number joins through the answer path: shown up, traced once, the added leg offered to the recorder alone', async () => {
    await setUp();
    const { addPartyCall, bridgeId, userA } = await externalAddParty();
    await db
      .updateTable('users')
      .set({ recordCalls: 1 })
      .where('id', '=', userA)
      .execute();
    const callers: Call[] = [];
    const legs: Leg[] = [];
    pipeline.deps.recorder = {
      onCallerUp: call => {
        callers.push(call);
        return Promise.resolve();
      },
      onLegUp: (_call, leg) => {
        legs.push(leg);
        return Promise.resolve();
      },
      onTransfereeUp: () => Promise.resolve(),
      onCallerEnded: () => Promise.resolve(),
      onLegEnded: () => Promise.resolve()
    };
    const states: string[] = [];
    pipeline.deps.bus.subscribe(envelope => {
      if (
        envelope.type === 'call.state' &&
        envelope.callId === addPartyCall.id
      ) {
        states.push(envelope.state);
      }
    });

    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15551234567'
    );

    // §10.6: the added leg's own row is live and up once the party joins.
    expect(states).toContain('up');
    const addedId = legs[0]?.channelId ?? '';
    // §10.2 "Three-way calls": the added party's participation is evaluated on its own flags;
    // the initiator's feature dial is never in the bridge, so nothing records it.
    expect(callers).toEqual([]);
    expect(legs.map(leg => [leg.kind, leg.userId])).toEqual([['trunk', null]]);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === `bridges/${bridgeId}/addChannel` &&
          (entry.body as { channel?: string }).channel === addedId
      )
    ).toBe(true);
    expect(addPartyCall.bridgeId).toBe(bridgeId);
    expect(pipeline.callByChannel.get(addedId)).toBe(addPartyCall);
    const answered = (addPartyCall.log.finish().log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event?: string })
      .filter(line => line.event === 'answered');
    expect(answered).toHaveLength(1);
  });

  it("*5 to an external number: the added leg's row ends when the added party leaves, not when they join", async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15551234567'
    );
    await sleep(SETTLE_MS);
    // §11.2 `calls.ended_at`: the added party is still in the three-way bridge.
    expect((await callsRow(addPartyCall.id)).endedAt).toBeNull();
    expect(pipeline.deps.state.calls.get(addPartyCall.id)?.state).toBe('up');

    const added = [...addPartyCall.legs.values()].find(
      leg => leg.state === 'up'
    );
    channelDestroyed(added?.channelId ?? '');

    await eventually(async () => {
      const row = await callsRow(addPartyCall.id);
      expect(row.status).toBe('answered');
      expect(row.answeredAt).not.toBeNull();
      expect(row.endedAt).not.toBeNull();
    });
  });

  /** The trunk originate an external `*5` sent, and the added leg's `calls` row once the added
   * party has left again. */
  async function externalAddPartyOutcome(addPartyCall: Call): Promise<{
    originate: { endpoint?: string; variables?: Record<string, string> };
    row: { toUri: string; direction: string };
  }> {
    const originate = fakeAri.calls.find(
      entry =>
        isPlacement(entry) &&
        ((entry.body as { endpoint?: string }).endpoint ?? '').includes(
          '@trunk-'
        )
    );
    await addedPartyLeaves(addPartyCall);
    const row = await db
      .selectFrom('calls')
      .select(['toUri', 'direction'])
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    return {
      originate: originate?.body ?? {},
      row
    };
  }

  it('*5 to a national number dials and records its E.164 form, as an outbound call (§10.1 Outbound step 4)', async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '030123456'
    );
    const { originate, row } = await externalAddPartyOutcome(addPartyCall);
    expect(originate.endpoint).toMatch(/^PJSIP\/\+4930123456@trunk-/u);
    expect(row).toEqual({ toUri: '+4930123456', direction: 'outbound' });
  });

  it('*5 honours a CLIR prefix dialled with the added number (§9.3 #31#)', async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    // A withheld call needs a PAI-carrying trunk (§9.4 "Anonymous calls").
    await db.updateTable('trunks').set({ calleridHeader: 'both' }).execute();
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '#31#+15551234567'
    );
    const { originate, row } = await externalAddPartyOutcome(addPartyCall);
    expect(originate.variables?.['CONNECTEDLINE(pres)']).toBe('prohib');
    expect(row.toUri).toBe('+15551234567');
  });

  it("*5 to one of the tenant's own DIDs rings its target internally, never over a trunk", async () => {
    await setUp();
    const { addPartyCall, bridgeId } = await externalAddParty();
    const userC = await seedUser(db);
    await seedExtension(db, '300', { userId: userC });
    await seedDevice(db, userC, 'e300-dabc');
    await registerDevice('e300-dabc');
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, userId: userC })
      .execute();
    await db
      .insertInto('dids')
      .values({
        id: newId(),
        number: '+15557777',
        targetId,
        createdAt: nowIso()
      })
      .execute();
    pipeline.deps.cache.invalidate();

    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15557777'
    );

    expect(addPartyCall.bridgeId).toBe(bridgeId);
    const endpoints = fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(entry => (entry.body as { endpoint?: string }).endpoint);
    expect(endpoints).toEqual(['PJSIP/e300-dabc']);
    await addedPartyLeaves(addPartyCall);
    const row = await db
      .selectFrom('calls')
      .select(['toUri', 'calleeUserId'])
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ toUri: '+15557777', calleeUserId: userC });
  });

  it('*5 to a parking slot is refused: a parked call is retrieved, not added', async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    await seedExtension(db, '701', { isParkingSlot: true });
    pipeline.deps.cache.invalidate();
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '701');
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${addPartyCall.callerChannelId}` &&
          entry.qs === `reason_code=${sipToHangupCause(404)}`
      )
    ).toBe(true);
    expect(addPartyCall.status).toBe('failed');
  });

  it('*8 on a ring-group member picks up a call ringing that group', async () => {
    await setUp();
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    const memberDeviceUsername = 'e300-dabc';
    await seedDevice(db, memberUserId, memberDeviceUsername);
    await seedMember(db, groupId, 0, memberUserId);
    // A group rings only a member's registered devices (§10.1 step 5).
    await registerDevice(memberDeviceUsername);

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newInternalCall(callerChannel.id, 'e100', '400');
    pipeline.registerCall(call);
    await cdr.open(call);
    const ringing = ringGroup(pipeline, call, groupId);
    // The batch rings the member's device before the picker steps in.
    await memberRinging(call);
    expect(
      fakeAri.calls.some(
        entry =>
          isPlacement(entry) &&
          (entry.body as { endpoint?: string }).endpoint ===
            `PJSIP/${memberDeviceUsername}`
      )
    ).toBe(true);

    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e200', '*8300');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '300');
    await ringing;

    expect(call.status).toBe('answered');
    expect(call.answeredByUserId).toBe(pickerUserId);
    // The group's own ring stopped: some channel other than the caller's or the picker's own was
    // hung up — the member's ringing device leg, not left ringing (§10.1 step 5's "the other
    // legs are hung up").
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path.startsWith('channels/') &&
          entry.path !== `channels/${callerChannel.id}` &&
          entry.path !== `channels/${pickerChannel.id}`
      )
    ).toBe(true);
    // The picker's own channel joined the *same* bridge as the group's own caller (§10.1 "Pickup").
    const callerJoin = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path.startsWith('bridges/') &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === callerChannel.id
    );
    if (callerJoin === undefined) {
      throw new Error('caller channel never joined a bridge');
    }
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === callerJoin.path &&
          (entry.body as { channel?: string }).channel === pickerChannel.id
      )
    ).toBe(true);
  });

  it("*8 on a ring-group member stops the group's hold music on the caller before bridging them", async () => {
    await setUp();
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    await seedDevice(db, memberUserId, 'e300-dabc');
    await seedMember(db, groupId, 0, memberUserId);
    await registerDevice('e300-dabc');
    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newInternalCall(callerChannel.id, 'e100', '400');
    pipeline.registerCall(call);
    await cdr.open(call);
    const ringing = ringGroup(pipeline, call, groupId);
    await memberRinging(call);
    const pickerCall = newInternalCall(
      fakeAri.addChannel({}).id,
      'e200',
      '*8300'
    );
    pickerCall.callerUserId = await seedUser(db);
    pipeline.registerCall(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '300');
    await ringing;

    // §10.2 "Ring groups": the group's hold music replaces ringback only while members ring.
    const mohPath = `channels/${callerChannel.id}/moh`;
    const stopIndex = fakeAri.calls.findIndex(
      entry => entry.method === 'DELETE' && entry.path === mohPath
    );
    const bridgeIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'POST' &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === callerChannel.id
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeLessThan(bridgeIndex);
  });

  it('*8 on an extension nobody owns is refused without answering any live call', async () => {
    await setUp();
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    const memberDeviceUsername = 'e300-dabc';
    await seedDevice(db, memberUserId, memberDeviceUsername);
    await seedMember(db, groupId, 0, memberUserId);
    // A group rings only a member's registered devices (§10.1 step 5).
    await registerDevice(memberDeviceUsername);

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newInternalCall(callerChannel.id, 'e100', '400');
    pipeline.registerCall(call);
    const ringing = ringGroup(pipeline, call, groupId);
    // The batch rings the member's device before the picker steps in.
    await memberRinging(call);

    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    // `999` is dialled nowhere: not a user, not a ring group, not a parking slot.
    const pickerCall = newInternalCall(pickerChannel.id, 'e200', '*8999');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '999');

    expect(pickerCall.status).toBe('failed');
    expect(call.answeredByUserId).toBeNull();
    expect(call.status).toBeNull();
    const pickerReleased = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${pickerChannel.id}` &&
        entry.qs === `reason_code=${sipToHangupCause(404)}`
    );
    expect(pickerReleased).toBe(true);
    // The group's own ring race is untouched: the member's device is never hung up by the
    // picker's failed attempt.
    const memberHungUp = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path.startsWith('channels/') &&
        entry.path !== `channels/${callerChannel.id}` &&
        entry.path !== `channels/${pickerChannel.id}`
    );
    expect(memberHungUp).toBe(false);

    // Settles the still-ringing batch so the test itself doesn't leave a dangling race.
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });
    await ringing;
  });

  it("*5 to a ring-group extension rings its member and joins the winner into the caller's own bridge", async () => {
    await setUp();
    const userA = await seedUser(db);
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    const memberDeviceUsername = 'e300-dabc';
    await seedDevice(db, memberUserId, memberDeviceUsername);
    await seedMember(db, groupId, 0, memberUserId);
    // A group rings only a member's registered devices (§10.1 step 5).
    await registerDevice(memberDeviceUsername);

    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(userAChannel.id, {
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5400');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);

    fakeAri.answerAfterMs = 10;
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '400');
    await addedPartyLeaves(addPartyCall);

    const row = await db
      .selectFrom('calls')
      .select('parentCallId')
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    expect(row.parentCallId).toBe(activeCall.id);
    const joinedNewParty = fakeAri.calls.some(entry => {
      if (
        entry.method !== 'POST' ||
        entry.path !== `bridges/${bridge.id}/addChannel`
      ) {
        return false;
      }
      const channel = (entry.body as { channel?: string }).channel;
      return (
        channel !== undefined &&
        channel !== customerChannel.id &&
        channel !== userAChannel.id
      );
    });
    expect(joinedNewParty).toBe(true);
    const addPartyChannelHungUp = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${addPartyChannel.id}`
    );
    expect(addPartyChannelHungUp).toBe(true);
  });

  /** 100 (userA) and a customer in a bridged call, then userA's `*5400` joins group 400's member. */
  async function threeWayCall(): Promise<{
    bridgeId: string;
    customerId: string;
    initiatorId: string;
    addedId: string;
  }> {
    const userA = await seedUser(db);
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    await seedDevice(db, memberUserId, 'e300-dabc');
    await seedMember(db, groupId, 0, memberUserId);
    await presence.resyncOnBoot();
    await registerDevice('e300-dabc');
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.status = 'answered';
    activeCall.legs.set(userAChannel.id, {
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    pipeline.callByChannel.set(userAChannel.id, activeCall);
    await cdr.open(activeCall);
    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5400');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);
    fakeAri.answerAfterMs = 10;
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '400');
    const added = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path === `bridges/${bridge.id}/addChannel` &&
        ![customerChannel.id, userAChannel.id].includes(
          (entry.body as { channel?: string }).channel ?? ''
        )
    );
    return {
      bridgeId: bridge.id,
      customerId: customerChannel.id,
      initiatorId: userAChannel.id,
      addedId: (added?.body as { channel?: string } | undefined)?.channel ?? ''
    };
  }

  function hungUpChannel(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  it('*5: the initiator hanging up ends the bridge for everyone (§10.2 "Three-way calls")', async () => {
    await setUp();
    const { bridgeId, customerId, initiatorId, addedId } = await threeWayCall();
    expect(addedId).not.toBe('');

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: initiatorId }),
      cause: 16
    });

    await eventually(() => {
      expect(hungUpChannel(customerId)).toBe(true);
      expect(hungUpChannel(addedId)).toBe(true);
      expect(
        fakeAri.calls.some(
          entry =>
            entry.method === 'DELETE' && entry.path === `bridges/${bridgeId}`
        )
      ).toBe(true);
    });
  });

  it('*5: the added party hanging up leaves the original two-party call intact', async () => {
    await setUp();
    const { customerId, initiatorId, addedId } = await threeWayCall();
    // Asterisk takes the added party's channel out of the bridge as it goes.
    await ari.bridges.removeChannel(
      (await ari.bridges.list())[0]?.id ?? '',
      addedId
    );

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: addedId }),
      cause: 16
    });
    await sleep(SETTLE_MS);

    expect(hungUpChannel(customerId)).toBe(false);
    expect(hungUpChannel(initiatorId)).toBe(false);
  });

  it("an answered call ending returns the callee's hint to NOT_INUSE and appends a presence_log row", async () => {
    await setUp();
    const userId = await seedUser(db);
    await seedExtension(db, '101', { userId });
    await seedDevice(db, userId, 'e101-dabc');

    await presence.resyncOnBoot();
    await registerDevice('e101-dabc');

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.calleeUserId = userId;
    pipeline.registerCall(call);
    fakeAri.answerAfterMs = 10;
    await cdr.open(call);

    await ringUser(pipeline, call, userId);

    function hintPuts(): { deviceState?: string }[] {
      return fakeAri.calls
        .filter(
          entry =>
            entry.method === 'PUT' &&
            entry.path === 'deviceStates/Stasis:presence-101'
        )
        .map(entry => entry.body as { deviceState?: string });
    }

    // The answer's presence refresh runs off the ring's own stack.
    await eventually(() => {
      expect(hintPuts().at(-1)).toEqual({ deviceState: 'INUSE' });
    });

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });

    await eventually(async () => {
      expect(hintPuts().at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      const logRows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', userId)
        .orderBy('since', 'asc')
        .execute();
      expect(logRows.at(-1)?.status).toBe('available');
      // The boot registration flip already wrote its own rows; hanging up the answered call
      // appends at least one more, back to `available` (§10.2 "Presence and BLF").
      expect(logRows.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('dialling a colleague marks the dialling user INUSE and the callee RINGING then INUSE, and ends both on hangup', async () => {
    await setUp();
    pipeline.deps.trunkState = trunkStateForTests();
    const callerUserId = await seedUser(db);
    await seedExtension(db, '100', { userId: callerUserId });
    await seedDevice(db, callerUserId, 'e100-dabc');
    const calleeUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: calleeUserId });
    await seedDevice(db, calleeUserId, 'e101-dabc');
    await presence.resyncOnBoot();
    await registerDevice('e100-dabc');
    await registerDevice('e101-dabc');
    expect(hintPutsFor('100').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });

    fakeAri.answerAfterMs = 300;
    const callerChannel = fakeAri.addChannel({
      name: 'PJSIP/e100-dabc-00000001',
      caller: { number: '100', name: '' }
    });
    const dialing = handleOutbound(pipeline, {
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '101'],
      channel: callerChannel
    });
    // §9.3: the dialling user's device is in a call from the dial; the callee's phone rings.
    await eventually(() => {
      expect(hintPutsFor('100').at(-1)).toEqual({ deviceState: 'INUSE' });
      expect(hintPutsFor('101').at(-1)).toEqual({ deviceState: 'RINGING' });
    });
    await dialing;
    await eventually(() => {
      expect(hintPutsFor('101').at(-1)).toEqual({ deviceState: 'INUSE' });
    });

    channelDestroyed(callerChannel.id);
    await eventually(async () => {
      expect(hintPutsFor('100').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      expect(hintPutsFor('101').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      // §10.2 "Presence and BLF": the busy stretch is in `presence_log`, with the counterpart.
      const callerRows = await db
        .selectFrom('presenceLog')
        .select(['status', 'peer'])
        .where('userId', '=', callerUserId)
        .orderBy('since', 'asc')
        .execute();
      expect(callerRows.map(row => row.status)).toEqual([
        'offline',
        'available',
        'busy',
        'available'
      ]);
      expect(callerRows[2]?.peer).toBe('101');
      const calleeRows = await db
        .selectFrom('presenceLog')
        .select(['status', 'peer'])
        .where('userId', '=', calleeUserId)
        .orderBy('since', 'asc')
        .execute();
      expect(calleeRows.map(row => row.status)).toEqual([
        'offline',
        'available',
        'busy',
        'available'
      ]);
      expect(calleeRows[2]?.peer).toBe('100');
    });
  });

  it.each([
    ['ring-group', '400'],
    ['user', '300']
  ] as const)(
    '*5 to a %s extension whose answer finds the running bridge gone hangs the added leg up',
    async (_kind, target) => {
      await setUp();
      const userA = await seedUser(db);
      const groupId = await seedRingGroup(db);
      await seedExtension(db, '400', { ringGroupId: groupId });
      const memberUserId = await seedUser(db);
      await seedExtension(db, '300', { userId: memberUserId });
      await seedDevice(db, memberUserId, 'e300-dabc');
      await seedMember(db, groupId, 0, memberUserId);
      await presence.resyncOnBoot();
      await registerDevice('e300-dabc');
      const customerChannel = fakeAri.addChannel({});
      const userAChannel = fakeAri.addChannel({});
      const activeCall = newInternalCall(
        customerChannel.id,
        '+15559999',
        '100'
      );
      activeCall.status = 'answered';
      activeCall.legs.set(userAChannel.id, {
        channelId: userAChannel.id,
        kind: 'device',
        userId: userA,
        state: 'up',
        endCause: null
      });
      const bridge = await ari.bridges.create({ type: 'mixing' });
      activeCall.bridgeId = bridge.id;
      pipeline.registerCall(activeCall);
      pipeline.callByChannel.set(userAChannel.id, activeCall);
      await cdr.open(activeCall);
      const addPartyChannel = fakeAri.addChannel({});
      const addPartyCall = newInternalCall(
        addPartyChannel.id,
        'e100',
        `*5${target}`
      );
      addPartyCall.callerUserId = userA;
      pipeline.registerCall(addPartyCall);
      fakeAri.answerAfterMs = 100;
      await cdr.open(addPartyCall);

      const adding = handleFeature(
        pipeline,
        presence,
        addPartyCall,
        'addParty',
        target
      );
      // The running call ends while the added party's device still rings: originated, and
      // answering only `answerAfterMs` later.
      await requestTo(fakeAri, 'POST', 'channels/create');
      await ari.bridges.destroy(bridge.id);
      await adding;

      const added = [...addPartyCall.legs.values()].find(
        leg => leg.userId === memberUserId && leg.state === 'up'
      );
      if (added === undefined) {
        throw new Error('the added party never answered');
      }
      // Hung up, not left in Stasis with nobody (§10.2 "Three-way calls": the initiator's call
      // is over, and with it the bridge the added party was to join).
      expect(hungUpChannel(added.channelId)).toBe(true);
      expect(hungUpChannel(addPartyChannel.id)).toBe(true);
      expect(addPartyCall.bridgeId).toBeNull();
      expect(activeCall.threeWayInitiatorChannelId).toBeUndefined();
      expect(addPartyCall.log.finish().log).toContain('"event":"joinFailed"');
    }
  );

  it("*5's own channel ending leaves the added party INUSE until their leg ends", async () => {
    await setUp();
    const userA = await seedUser(db);
    const userC = await seedUser(db);
    await seedDevice(db, userC, 'e300-dabc');
    await seedExtension(db, '300', { userId: userC });
    await presence.resyncOnBoot();
    await registerDevice('e300-dabc');

    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(userAChannel.id, {
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5300');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);
    fakeAri.answerAfterMs = 10;
    await cdr.open(addPartyCall);
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '300');
    await eventually(() => {
      expect(hintPutsFor('300').at(-1)).toEqual({ deviceState: 'INUSE' });
    });

    // Asterisk answers the feature channel's own hangup with `ChannelDestroyed`; the added
    // party is still bridged (§10.2 "Three-way calls"), so their hint stays.
    channelDestroyed(addPartyChannel.id);
    await sleep(SETTLE_MS);
    expect(hintPutsFor('300').at(-1)).toEqual({ deviceState: 'INUSE' });
    // §11.2 `calls.ended_at`: the added leg's own row ends as the added party leaves, not here.
    expect((await callsRow(addPartyCall.id)).endedAt).toBeNull();

    const addedLeg = [...addPartyCall.legs.values()].find(
      leg => leg.state === 'up'
    );
    if (addedLeg === undefined) {
      throw new Error('no added leg is up');
    }
    channelDestroyed(addedLeg.channelId);
    await eventually(async () => {
      expect(hintPutsFor('300').at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      const row = await callsRow(addPartyCall.id);
      expect(row.status).toBe('answered');
      expect(row.endedAt).not.toBeNull();
    });
  });

  /** A bridged call between a customer and the parker, which the parker then parks with `*70`:
   * an inbound call the parker answered, or with `parkerIsCaller` one the parker dialled out. */
  async function setUpParkedCall(
    options: { parkerIsCaller?: boolean; recorder?: ParticipationRecorder } = {}
  ): Promise<{
    activeCall: Call;
    parkerUserId: string;
    bridgeId: string;
    partyChannelId: string;
    parkerChannelId: string;
  }> {
    await setUp();
    pipeline.deps.recorder = options.recorder ?? null;
    await seedExtension(db, '701', { isParkingSlot: true });
    const parkerUserId = await seedUser(db);
    await seedExtension(db, '100', { userId: parkerUserId });
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const parkerChannel = fakeAri.addChannel({});
    const parkerIsCaller = options.parkerIsCaller === true;
    const activeCall = newCall({
      id: newId(),
      direction: parkerIsCaller ? 'outbound' : 'inbound',
      callerChannelId: parkerIsCaller ? parkerChannel.id : customerChannel.id,
      from: parkerIsCaller ? '100' : '+15559999',
      to: parkerIsCaller ? '+15559999' : '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.status = 'answered';
    if (parkerIsCaller) {
      activeCall.callerUserId = parkerUserId;
    }
    const answeredLeg: Leg = parkerIsCaller
      ? {
          channelId: customerChannel.id,
          kind: 'trunk',
          userId: null,
          state: 'up',
          endCause: null
        }
      : {
          channelId: parkerChannel.id,
          kind: 'device',
          userId: parkerUserId,
          state: 'up',
          endCause: null
        };
    activeCall.legs.set(answeredLeg.channelId, answeredLeg);
    pipeline.callByChannel.set(answeredLeg.channelId, activeCall);
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, parkerChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);
    // The state `legs.ts`'s `winLeg` would have left for the parker's answered leg.
    presence.setCallState(
      parkerUserId,
      'inCall',
      '+15559999',
      null,
      activeCall.id
    );
    // Its refresh has logged the parker `busy` before the park moves them on.
    await eventually(async () => {
      const rows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', parkerUserId)
        .execute();
      expect(rows.map(row => row.status)).toEqual(['busy']);
    });

    const parkDialChannel = fakeAri.addChannel({});
    const parkDial = newInternalCall(parkDialChannel.id, 'e100', '*70');
    parkDial.callerUserId = parkerUserId;
    pipeline.registerCall(parkDial);
    await cdr.open(parkDial);

    await handleFeature(pipeline, presence, parkDial, 'park', '');
    return {
      activeCall,
      parkerUserId,
      bridgeId: bridge.id,
      partyChannelId: customerChannel.id,
      parkerChannelId: parkerChannel.id
    };
  }

  it('parked call retrieved by dialing 701', async () => {
    const { activeCall, bridgeId, partyChannelId } = await setUpParkedCall();

    const retrieverUserId = await seedUser(db);
    const retrieverChannel = fakeAri.addChannel({});
    const retrieverCall = newInternalCall(retrieverChannel.id, 'e200', '701');
    retrieverCall.callerUserId = retrieverUserId;
    pipeline.registerCall(retrieverCall);
    await cdr.open(retrieverCall);

    const outcome = await retrieveParkedCall(
      pipeline,
      presence,
      retrieverCall,
      '701'
    );

    expect(outcome).toBe('retrieved');
    expect(activeCall.answeredByUserId).toBe(retrieverUserId);
    // §10.2 "Call parking": the party waited in a `holding` bridge, the original conversation's
    // bridge being destroyed; retrieval moves them into a `mixing` bridge the retriever joins.
    const bridgeTypes = fakeAri.calls
      .filter(entry => entry.method === 'POST' && entry.path === 'bridges')
      .map(entry => (entry.body as { type?: string }).type);
    expect(bridgeTypes).toEqual(['mixing', 'holding', 'mixing']);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' && entry.path === `bridges/${bridgeId}`
      )
    ).toBe(true);
    const retrieverJoin = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === retrieverChannel.id
    );
    if (retrieverJoin === undefined) {
      throw new Error('retriever channel never joined a bridge');
    }
    expect(retrieverJoin.path).not.toBe(`bridges/${bridgeId}/addChannel`);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === retrieverJoin.path &&
          (entry.body as { channel?: string }).channel === partyChannelId
      )
    ).toBe(true);
    expect(activeCall.bridgeId).toBe(
      retrieverJoin.path.slice('bridges/'.length, -'/addChannel'.length)
    );
    // The retriever's own channel now carries the conversation (§9.3 table): it must stay up.
    const retrieverHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${retrieverChannel.id}`
    );
    expect(retrieverHangup).toBe(false);
    // The held party stops hearing hold music once the retriever joins (§10.2 "Call parking").
    const mohStopped = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${partyChannelId}/moh`
    );
    expect(mohStopped).toBe(true);
  });

  /** The retriever's own user, extension and device, added after `setUpParkedCall` warmed the
   * config snapshot; the invalidation stands in for the api's `/internal/configChanged`. */
  async function seedRetriever(): Promise<string> {
    pipeline.deps.trunkState = trunkStateForTests();
    const retrieverUserId = await seedUser(db);
    await seedExtension(db, '200', { userId: retrieverUserId });
    await seedDevice(db, retrieverUserId, 'e200-dabc');
    pipeline.deps.cache.invalidate();
    return retrieverUserId;
  }

  function outboundEvent(channel: Channel, dialed: string): AriEvent {
    return {
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', dialed],
      channel
    };
  }

  it('dialling 701 from a registered device retrieves the parked call through the outbound entry', async () => {
    const { activeCall, partyChannelId } = await setUpParkedCall();
    const retrieverUserId = await seedRetriever();
    const retrieverChannel = fakeAri.addChannel({
      name: 'PJSIP/e200-dabc-00000001',
      caller: { number: '200', name: '' }
    });

    await handleOutbound(pipeline, outboundEvent(retrieverChannel, '701'));

    expect(activeCall.answeredByUserId).toBe(retrieverUserId);
    const retrieverJoin = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === retrieverChannel.id
    );
    expect(retrieverJoin).toBeDefined();
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === retrieverJoin?.path &&
          (entry.body as { channel?: string }).channel === partyChannelId
      )
    ).toBe(true);
    // The retriever's own channel now carries the conversation (§9.3 table): it stays up.
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${retrieverChannel.id}`
      )
    ).toBe(false);
  });

  it('dialling an empty parking slot plays the invalid-option prompt and releases with 404', async () => {
    await setUp();
    await seedExtension(db, '701', { isParkingSlot: true });
    await seedRetriever();
    const channel = fakeAri.addChannel({
      name: 'PJSIP/e200-dabc-00000001',
      caller: { number: '200', name: '' }
    });

    await handleOutbound(pipeline, outboundEvent(channel, '701'));

    // §9.3 table, §10.1 Outbound step 3: the short error tone, then the release.
    const relevant = fakeAri.calls.filter(
      entry =>
        entry.path === `channels/${channel.id}/play` ||
        (entry.method === 'DELETE' && entry.path === `channels/${channel.id}`)
    );
    expect(relevant.map(entry => entry.method)).toEqual(['POST', 'DELETE']);
    expect((relevant[0]?.body as { media?: string }).media).toBe(
      defaultPrompt('invalid')
    );
    expect(relevant[1]?.qs).toBe(`reason_code=${sipToHangupCause(404)}`);
  });

  it('the parked party hanging up releases the slot instead of leaving it occupied', async () => {
    const { partyChannelId } = await setUpParkedCall();

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: partyChannelId }),
      cause: 16
    });

    // §9.3 "a parking slot: INUSE while a call is parked there" — released, so the hint reverts.
    await eventually(() => {
      const hintPuts = fakeAri.calls.filter(
        entry =>
          entry.method === 'PUT' &&
          entry.path === 'deviceStates/Stasis:presence-701'
      );
      expect(
        (hintPuts.at(-1)?.body as { deviceState?: string }).deviceState
      ).toBe('NOT_INUSE');
    });

    const retrieverChannel = fakeAri.addChannel({});
    const retrieverCall = newInternalCall(retrieverChannel.id, 'e200', '701');
    pipeline.registerCall(retrieverCall);
    await cdr.open(retrieverCall);
    const outcome = await retrieveParkedCall(
      pipeline,
      presence,
      retrieverCall,
      '701'
    );
    expect(outcome).toBe('empty');
  });

  it("parking hangs up the parker's own channel, not just removes it from the bridge", async () => {
    const { parkerChannelId } = await setUpParkedCall();

    const parkerHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${parkerChannelId}`
    );
    expect(parkerHangup).toBe(true);
  });

  it("parking returns the parker's own hint from INUSE and their presence from busy", async () => {
    const { parkerUserId } = await setUpParkedCall();

    await eventually(async () => {
      expect(hintPutsFor('100').at(-1)).not.toEqual({ deviceState: 'INUSE' });
      const rows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', parkerUserId)
        .orderBy('since', 'asc')
        .execute();
      expect(rows.map(row => row.status)).toEqual(['busy', 'offline']);
    });
  });

  /** A stub recorder noting each participation it is told has started or ended. */
  function endingRecorder(ended: string[]): ParticipationRecorder {
    return {
      onCallerUp: () => Promise.resolve(),
      onLegUp: (_call, leg) => {
        ended.push(`up:${leg.channelId}`);
        return Promise.resolve();
      },
      onTransfereeUp: () => Promise.resolve(),
      onCallerEnded: call => {
        ended.push(`caller:${call.callerChannelId}`);
        return Promise.resolve();
      },
      onLegEnded: (_call, leg) => {
        ended.push(`leg:${leg.channelId}`);
        return Promise.resolve();
      }
    };
  }

  it("parking ends the parker's recorded participation, as leaving the bridge does (§10.2 Recording semantics)", async () => {
    const answererEnded: string[] = [];
    const answerer = await setUpParkedCall({
      recorder: endingRecorder(answererEnded)
    });
    expect(answererEnded).toEqual([`leg:${answerer.parkerChannelId}`]);

    const callerEnded: string[] = [];
    const caller = await setUpParkedCall({
      parkerIsCaller: true,
      recorder: endingRecorder(callerEnded)
    });
    expect(callerEnded).toEqual([`caller:${caller.parkerChannelId}`]);
  });

  /** Dials slot 701 from a fresh retriever channel, which `retrieveParkedCall` folds into the
   * parked call. */
  async function retrieve(): Promise<{
    retrieverUserId: string;
    retrieverChannelId: string;
    retrieverCall: Call;
  }> {
    const retrieverUserId = await seedUser(db);
    // Stands in for the api's `/internal/configChanged`, so presence knows the new user.
    pipeline.deps.cache.invalidate();
    const retrieverChannel = fakeAri.addChannel({});
    const retrieverCall = newInternalCall(retrieverChannel.id, 'e200', '701');
    retrieverCall.callerUserId = retrieverUserId;
    pipeline.registerCall(retrieverCall);
    await cdr.open(retrieverCall);
    await expect(
      retrieveParkedCall(pipeline, presence, retrieverCall, '701')
    ).resolves.toBe('retrieved');
    return {
      retrieverUserId,
      retrieverChannelId: retrieverChannel.id,
      retrieverCall
    };
  }

  function hungUp(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  it('the retriever hanging up ends the parked party’s call instead of leaving it in dead air', async () => {
    const ended: string[] = [];
    const { activeCall, partyChannelId } = await setUpParkedCall({
      recorder: endingRecorder(ended)
    });
    const { retrieverUserId, retrieverChannelId, retrieverCall } =
      await retrieve();

    // The retriever is the parked call's answered leg: in a call, and recorded on its own flags.
    expect(pipeline.callByChannel.get(retrieverChannelId)).toBe(activeCall);
    expect(ended).toContain(`up:${retrieverChannelId}`);
    await eventually(() => {
      expect(pipeline.deps.state.presence.get(retrieverUserId)?.status).toBe(
        'busy'
      );
    });
    expect((await callsRow(retrieverCall.id)).endedAt).not.toBeNull();

    channelDestroyed(retrieverChannelId);
    await eventually(() => {
      expect(hungUp(partyChannelId)).toBe(true);
    });
    expect(ended).toContain(`leg:${retrieverChannelId}`);
    channelDestroyed(partyChannelId);
    await eventually(async () => {
      const row = await callsRow(activeCall.id);
      expect(row.status).toBe('answered');
      expect(row.endedAt).not.toBeNull();
    });
    await eventually(() => {
      expect(
        pipeline.deps.state.presence.get(retrieverUserId)?.status
      ).not.toBe('busy');
    });
  });

  it('a call its caller parked still ends its row once the retrieved conversation ends', async () => {
    const { activeCall, partyChannelId } = await setUpParkedCall({
      parkerIsCaller: true
    });
    const { retrieverChannelId } = await retrieve();

    // The party hangs up this time: the retriever is hung up with them, and the row ends.
    channelDestroyed(partyChannelId);
    await eventually(() => {
      expect(hungUp(retrieverChannelId)).toBe(true);
    });
    await eventually(async () => {
      const row = await callsRow(activeCall.id);
      expect(row.status).toBe('answered');
      expect(row.endedAt).not.toBeNull();
    });
  });

  it('a call its caller parked ends its row when the parked party hangs up while waiting', async () => {
    const { activeCall, partyChannelId } = await setUpParkedCall({
      parkerIsCaller: true
    });

    channelDestroyed(partyChannelId);

    await eventually(async () => {
      expect((await callsRow(activeCall.id)).endedAt).not.toBeNull();
    });
  });

  it('an unanswered parking ring-back routes the parked party to the tenant fallback target', async () => {
    await setUp(PARKING_TIMEOUT_S);
    // §9.1: the party the fallback plays to may be a leg the core originated, with no entry of
    // its own that set its language.
    await db.updateTable('settings').set({ language: 'de' }).execute();
    // No device for the parker at all: `ringParkerBack` originates nothing and settles the
    // ring-back as unanswered immediately, without needing to wait out its own 30 s race window.
    await seedExtension(db, '701', { isParkingSlot: true });
    const parkerUserId = await seedUser(db);
    await seedExtension(db, '100', { userId: parkerUserId });
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const parkerChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(parkerChannel.id, {
      channelId: parkerChannel.id,
      kind: 'device',
      userId: parkerUserId,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, parkerChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const parkDialChannel = fakeAri.addChannel({});
    const parkDial = newInternalCall(parkDialChannel.id, 'e100', '*70');
    parkDial.callerUserId = parkerUserId;
    pipeline.registerCall(parkDial);
    await cdr.open(parkDial);

    await handleFeature(pipeline, presence, parkDial, 'park', '');

    // The slot times out, the ring-back finds no device, and the fallback releases the party.
    await eventually(async () => {
      // seedSettings() leaves settings.fallbackTargetId NULL, so §11.3's own rule for that case
      // applies: the party is released with 404, not just dropped as 'missed' without a code.
      const fallbackReleased = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${customerChannel.id}` &&
          entry.qs === `reason_code=${sipToHangupCause(404)}`
      );
      expect(fallbackReleased).toBe(true);
      expect(languageSet(fakeAri, customerChannel.id, 'de')).toBe(true);
      const ringbackRows = await db
        .selectFrom('calls')
        .select('status')
        .where('direction', '=', 'internal')
        .where('toUri', '=', '100')
        .execute();
      expect(ringbackRows).toHaveLength(1);
      expect(ringbackRows[0]?.status).not.toBe('interrupted');
      expect(pipeline.channelless.size).toBe(0);
    }, RINGBACK_WAIT_MS);
    // The ring-back has no caller channel, and no request is made against one.
    expect(fakeAri.calls.some(entry => entry.path.includes('/null'))).toBe(
      false
    );
  }, 10_000);

  it('parking timeout rings the parker back through the pipeline and joins the parked bridge on answer', async () => {
    await setUp(PARKING_TIMEOUT_S);
    // The ring-back is a real internal call through `runUserStep`/`ringUser`;
    // this test wants the parker's device to answer promptly once dialled.
    fakeAri.answerAfterMs = 10;
    const parkerDeviceUsername = 'e100-dabc';
    await seedExtension(db, '701', { isParkingSlot: true });
    const parkerUserId = await seedUser(db);
    await seedExtension(db, '100', { userId: parkerUserId });
    // the parking ring-back rings the parker, whose device must be reachable (§10.1 step 4).
    fakeAri.registerEndpoint(parkerDeviceUsername);
    await seedDevice(db, parkerUserId, parkerDeviceUsername);
    await presence.resyncOnBoot();
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const parkerChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(parkerChannel.id, {
      channelId: parkerChannel.id,
      kind: 'device',
      userId: parkerUserId,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, parkerChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);
    callUp(pipeline.deps, activeCall);

    const parkDialChannel = fakeAri.addChannel({});
    const parkDial = newInternalCall(parkDialChannel.id, 'e100', '*70');
    parkDial.callerUserId = parkerUserId;
    pipeline.registerCall(parkDial);
    await cdr.open(parkDial);

    await handleFeature(pipeline, presence, parkDial, 'park', '');

    // The slot times out and the ring-back's answer joins the parker to the parked party.
    await eventually(() => {
      const rangParker = fakeAri.calls.some(
        entry =>
          isPlacement(entry) &&
          (entry.body as { endpoint?: string }).endpoint ===
            `PJSIP/${parkerDeviceUsername}`
      );
      expect(rangParker).toBe(true);
      // §10.2 "Call parking": "whose answer lands in the parked bridge" — the bridge the customer
      // is waiting in, not a bridge of the ring-back's own (legs.ts's `winLeg` with
      // `existingBridgeId`).
      const customerJoins = fakeAri.calls.filter(
        entry =>
          entry.method === 'POST' &&
          entry.path.endsWith('/addChannel') &&
          (entry.body as { channel?: string }).channel === customerChannel.id
      );
      const parkedBridgePath = customerJoins.at(-1)?.path;
      expect(parkedBridgePath).toBeDefined();
      expect(parkedBridgePath).not.toBe(`bridges/${bridge.id}/addChannel`);
      const joinedParkedBridge = fakeAri.calls.some(entry => {
        if (entry.method !== 'POST' || entry.path !== parkedBridgePath) {
          return false;
        }
        const channel = (entry.body as { channel?: string }).channel;
        return (
          channel !== undefined &&
          channel !== customerChannel.id &&
          channel !== parkerChannel.id
        );
      });
      expect(joinedParkedBridge).toBe(true);
    }, RINGBACK_WAIT_MS);
    // The ring-back's own `calls` row (an internal call to the parker's extension) is closed
    // out, not left at the `interrupted` placeholder `CdrWriter.open` writes; the parked call
    // has its answerer by then.
    await eventually(async () => {
      const ringbackRow = await db
        .selectFrom('calls')
        .select(['direction', 'status', 'calleeUserId', 'endedAt'])
        .where('toUri', '=', '100')
        .where('direction', '=', 'internal')
        .executeTakeFirstOrThrow();
      expect(ringbackRow.direction).toBe('internal');
      expect(ringbackRow.status).toBe('answered');
      expect(ringbackRow.calleeUserId).toBe(parkerUserId);
      expect(ringbackRow.endedAt).not.toBeNull();
    }, RINGBACK_WAIT_MS);
    expect(activeCall.answeredByUserId).toBe(parkerUserId);
    expect(pipeline.channelless.size).toBe(0);
    // §10.3 "Live calls": the parker who answered is connected in the parked call itself, their
    // answered leg one of its own, so they may end or transfer it.
    const parkerLeg = [...activeCall.legs.values()].find(
      leg => leg.userId === parkerUserId && leg.state === 'up'
    );
    expect(parkerLeg?.channelId).not.toBe(parkerChannel.id);
    expect(pipeline.callByChannel.get(parkerLeg?.channelId ?? '')).toBe(
      activeCall
    );
    expect(
      liveView(
        pipeline.deps.state.calls.get(activeCall.id) ?? expect.unreachable()
      ).connectedUserIds
    ).toEqual([parkerUserId]);
  }, 10_000);

  it('finds a caller who left only by a leg they joined again by, and the other party among the legs (§10.2 "Call parking")', () => {
    const call = newInternalCall('caller-gone', '100', '+15559999');
    call.callerUserId = 'parker';
    call.callerEnded = true;
    for (const [channelId, userId] of [
      ['party', null],
      ['ringback', 'parker']
    ] as const) {
      call.legs.set(channelId, {
        channelId,
        kind: userId === null ? 'trunk' : 'device',
        userId,
        state: 'up',
        endCause: null
      });
    }
    call.bridgeId = 'bridge';

    expect(channelOf(call, 'parker')).toBe('ringback');
    expect(otherChannelIn(call, 'ringback')).toBe('party');
    expect(otherChannelIn(call, 'party')).toBe('ringback');
  });

  it('*95<ext> admits a caller who is a member of the ring group only through a user group', async () => {
    await setUp();
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Support',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    const userGroupId = newId();
    await db
      .insertInto('userGroups')
      .values({ id: userGroupId, name: 'Support staff', createdAt: nowIso() })
      .execute();
    await db
      .insertInto('userGroupUsers')
      .values({ groupId: userGroupId, userId: memberUserId })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 0, userGroupId, userId: null })
      .execute();

    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e300', '*95400');
    call.callerUserId = memberUserId;
    pipeline.registerCall(call);
    await cdr.open(call);

    // The menu's wait for a digit, which the caller's hangup ends.
    const menuListening = nextSubscription(ari);
    const done = handleFeature(pipeline, presence, call, 'mailbox', '400');
    await menuListening;
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    await done;

    const forbidden = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${channel.id}` &&
        entry.qs === `reason_code=${sipToHangupCause(403)}`
    );
    expect(forbidden).toBe(false);
    const answered = fakeAri.calls.some(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${channel.id}/answer`
    );
    expect(answered).toBe(true);
  });

  it('*96 digit 1 plays the first new message, marks it read and refreshes MWI', async () => {
    await setUp();
    const ownerId = await seedUser(db);
    const messageId = await seedVoicemail(db, ownerId, `${newId()}.wav`);

    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e100', '*96');
    call.callerUserId = ownerId;
    pipeline.registerCall(call);
    await cdr.open(call);

    // The menu's wait for a digit, after its answer.
    const menuListening = nextSubscription(ari);
    const done = handleFeature(pipeline, presence, call, 'ownVoicemail', '');
    await menuListening;
    // Digit 1 plays the message, waiting for the playback to end ...
    const messagePlaying = nextSubscription(ari);
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id }),
      digit: '1'
    });
    await messagePlaying;
    // ... then marks it read, refreshes MWI and waits for the next digit, which the hangup ends.
    await nextSubscription(ari);
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    await done;

    const row = await db
      .selectFrom('voicemails')
      .select('read')
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.read).toBe(1);
    const mwiPut = fakeAri.calls.find(
      entry =>
        entry.method === 'PUT' && entry.path === `mailboxes/user:${ownerId}`
    );
    expect(mwiPut?.body).toEqual({ oldMessages: 1, newMessages: 0 });
  });

  it('*97<ext> deposits the caller in the mailbox without ringing', async () => {
    await setUp();
    const ownerId = await seedUser(db);
    await seedExtension(db, '150', { userId: ownerId });

    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e100', '*97150');
    pipeline.registerCall(call);
    await cdr.open(call);

    const done = handleFeature(pipeline, presence, call, 'deposit', '150');
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );

    const originated = fakeAri.calls.some(entry => isPlacement(entry));
    expect(originated).toBe(false);

    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: {
        name: (recordCall.body as { name: string }).name,
        duration: 5
      }
    });
    await done;

    const row = await db
      .selectFrom('voicemails')
      .select('mailboxUserId')
      .executeTakeFirstOrThrow();
    expect(row.mailboxUserId).toBe(ownerId);
  });

  it('a greeting recorded over *95<ext> digit 0 is what the next deposit plays', async () => {
    await setUp();
    const ownerId = await seedUser(db);
    await seedExtension(db, '150', { userId: ownerId });

    // `*95150` by the owner: the permission check warms the config snapshot before the recording.
    const menuChannel = fakeAri.addChannel({});
    const menuCall = newInternalCall(menuChannel.id, 'e150', '*95150');
    menuCall.callerUserId = ownerId;
    pipeline.registerCall(menuCall);
    await cdr.open(menuCall);
    const menuListening = nextSubscription(ari);
    const menu = handleFeature(pipeline, presence, menuCall, 'mailbox', '150');
    await menuListening;
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: menuChannel.id }),
      digit: '0'
    });
    const greetingRecord = await requestTo(
      fakeAri,
      'POST',
      `channels/${menuChannel.id}/record`
    );
    // Once the greeting is stored, the menu waits for its next digit, which the hangup ends.
    const nextDigitListening = nextSubscription(ari);
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: {
        name: (greetingRecord.body as { name: string }).name,
        duration: 4
      }
    });
    await nextDigitListening;
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: menuChannel.id })
    });
    await menu;
    const asset = await db
      .selectFrom('audioAssets')
      .select(['id', 'kind'])
      .executeTakeFirstOrThrow();
    expect(asset.kind).toBe('vmGreeting');

    // §10.2 "Mailbox access": the REST API and the phone share one greeting.
    const depositChannel = fakeAri.addChannel({});
    const depositCall = newInternalCall(depositChannel.id, 'e100', '*97150');
    pipeline.registerCall(depositCall);
    await cdr.open(depositCall);
    const done = handleFeature(
      pipeline,
      presence,
      depositCall,
      'deposit',
      '150'
    );
    // Recording starts only once the greeting played to the end.
    const depositRecord = await requestTo(
      fakeAri,
      'POST',
      `channels/${depositChannel.id}/record`
    );
    const greetingPlay = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${depositChannel.id}/play`
    );
    expect((greetingPlay?.body as { media?: string }).media).toBe(
      `sound:/media/prompts/${asset.id}`
    );
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: {
        name: (depositRecord.body as { name: string }).name,
        duration: 5
      }
    });
    await done;
  });
});
