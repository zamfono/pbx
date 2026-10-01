import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement, placedCallerId } from '../ari/fake.js';
import { defaultChannel, type Channel, type Logger } from '../ari/types.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { ATTEMPT_NO_RESPONSE_MS } from '../routing/trunk.js';
import { eventually } from '../testing/eventually.js';
import { newCall, type Call } from './call.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import { ringGroup } from './ringGroup.js';
import { ringUser } from './ringUser.js';
import { TrunkState } from './trunkState.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// Q.850 causes as ARI's `ChannelDestroyed` carries them: 41 temporary failure (SIP 503), 17 user
// busy (SIP 486).
const AST_CAUSE_TEMPORARY_FAILURE = 41;
const AST_CAUSE_USER_BUSY = 17;
// Q.850 21, call rejected: what chan_pjsip maps 401, 403, 407 and 603 alike to.
const AST_CAUSE_CALL_REJECTED = 21;

function fakeCdr(): PipelineDeps['cdr'] {
  return { open: () => Promise.resolve(), finish: () => Promise.resolve() };
}

async function seedDid(db: Db, number: string): Promise<string> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, targetId, createdAt: nowIso() })
    .execute();
  return id;
}

async function seedSettings(db: Db): Promise<void> {
  const mainDidId = await seedDid(db, '+491110000');
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

async function seedUser(
  db: Db,
  overrides: {
    calleridDidId?: string;
    findMe?: { number: string; delayS: number }[];
  } = {}
): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Member',
      email: `${id}@example.com`,
      createdAt: nowIso(),
      mailboxEnabled: 0,
      ringTimeoutS: 30,
      calleridDidId: overrides.calleridDidId ?? null,
      findMeJson: overrides.findMe ? JSON.stringify(overrides.findMe) : null
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

/** A `from`-header trunk with one host: `registration` dials the trunk's section, `ip` the host. */
async function seedTrunk(
  db: Db,
  priority: number,
  authMode: 'registration' | 'ip' = 'registration'
): Promise<string> {
  const id = newId();
  await db
    .insertInto('trunks')
    .values({
      id,
      name: `trunk-${priority}`,
      priority,
      emergency: 1,
      authMode,
      username: authMode === 'registration' ? `user${priority}` : null,
      passwordEnc: authMode === 'registration' ? Buffer.from('secret') : null,
      inboundAuth: 0,
      transport: 'udp',
      calleridHeader: 'from',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId: id,
      priority: 1,
      host: `sip${priority}.example.com`,
      port: null,
      direction: 'both'
    })
    .execute();
  return id;
}

/** An outbound route over `trunkId`; `onlyUserId` restricts its caller list to that one user. */
async function seedRoute(
  db: Db,
  priority: number,
  trunkId: string,
  onlyUserId: string | null = null
): Promise<void> {
  const id = newId();
  await db
    .insertInto('outboundRoutes')
    .values({ id, priority, trunkId, createdAt: nowIso() })
    .execute();
  if (onlyUserId !== null) {
    await db
      .insertInto('outboundRouteUsers')
      .values({ routeId: id, userId: onlyUserId })
      .execute();
  }
}

async function seedExternalForward(
  db: Db,
  userId: string,
  number: string
): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: number })
    .execute();
  await db
    .insertInto('userForwardRules')
    .values({ userId, condition: 'unconditional', targetId })
    .execute();
}

async function seedRingGroup(db: Db, memberIds: string[]): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({
      id,
      name: `Group ${id}`,
      strategy: 'simultaneous',
      ringTimeoutS: 30,
      mailboxEnabled: 0,
      createdAt: nowIso()
    })
    .execute();
  for (const [position, userId] of memberIds.entries()) {
    // eslint-disable-next-line no-await-in-loop -- members keep their positions in order
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId: id, position, userId, userGroupId: null })
      .execute();
  }
  return id;
}

type Originate = {
  endpoint: string;
  callerId?: string;
  variables?: Record<string, string>;
};

function originates(fakeAri: FakeAri): Originate[] {
  return fakeAri.calls
    .filter(entry => isPlacement(entry))
    .map(entry => ({
      ...(entry.body as Originate),
      callerId: placedCallerId(entry)
    }));
}

function hangups(fakeAri: FakeAri, channelId: string): number {
  return fakeAri.calls.filter(
    entry => entry.method === 'DELETE' && entry.path === `channels/${channelId}`
  ).length;
}

/** The channel the fake originated to `endpoint` (the fake names a channel after its endpoint). */
async function channelTo(ari: AriClient, endpoint: string): Promise<Channel> {
  const channel = (await ari.channels.list()).find(
    entry => entry.name === endpoint
  );
  if (!channel) {
    throw new Error(`no channel originated to ${endpoint}`);
  }
  return channel;
}

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
 * Waits until the ring-group batch tracks `count` member legs, attempts replacing one another
 * included: a leg is traced once its originate returned and the race holds it, so an event the
 * test emits for it from here on reaches the race.
 */
function membersRinging(call: Call, count: number): Promise<void> {
  return eventually(() => {
    expect(
      traceEvents(call).filter(event => event === 'ringGroupMember')
    ).toHaveLength(count);
  });
}

describe('external ring-race legs (§10.1 steps 4 and 5)', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let trunkState: TrunkState;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let callerChannel: Channel;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let call: Call;

  function emit(
    type: 'ChannelStateChange' | 'ChannelDestroyed',
    channelId: string,
    extra: { state?: string; cause?: number; techCause?: number } = {}
  ): void {
    fakeAri.emit({
      type,
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId, state: extra.state ?? 'Down' }),
      ...(extra.cause === undefined ? {} : { cause: extra.cause }),
      // eslint-disable-next-line camelcase -- ARI's own field name
      ...(extra.techCause === undefined ? {} : { tech_cause: extra.techCause })
    });
  }

  /** Asterisk dials the channel while it answers the originate; a far end that refuses at once
   * has the first originated channel destroyed before the core learns its id. */
  function refuseFirstOriginate(extra: {
    cause: number;
    techCause?: number;
  }): void {
    fakeAri.onOriginate = channel => {
      fakeAri.onOriginate = null;
      emit('ChannelDestroyed', channel.id, extra);
    };
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 60_000;
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    const state = new StateStore();
    trunkState = new TrunkState({
      ari,
      ami: new AmiClient({
        host: '127.0.0.1',
        port: 1,
        username: 'zamfono',
        password: 'secret',
        log: noopLogger
      }),
      cache: new ConfigCache(db),
      state,
      bus: new EventBus(),
      now: nowIso
    });
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state,
      bus: new EventBus(),
      cdr: fakeCdr(),
      now: nowIso,
      trunkState,
      presence: null
    });
    callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  describe("a ring-group member's external forward", () => {
    it("rings over the route's trunk as the member's own call, alongside the other members, and is hung up when another member answers", async () => {
      const memberDidId = await seedDid(db, '+491230000');
      const forwarding = await seedUser(db, { calleridDidId: memberDidId });
      await seedExternalForward(db, forwarding, '+15557777');
      // A member who forwards is still skipped while offline (§10.1 step 5).
      await seedDevice(db, forwarding, 'member-forwarding');
      const other = await seedUser(db);
      await seedDevice(db, other, 'member-other');
      const trunkId = await seedTrunk(db, 1, 'ip');
      await seedRoute(db, 1, trunkId);
      const groupId = await seedRingGroup(db, [forwarding, other]);

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 2);

      // Both legs ring at once: the external leg is originated without waiting for its answer.
      const external = `PJSIP/+15557777@trunk-${trunkId}/sip:sip1.example.com`;
      expect(originates(fakeAri).map(body => body.endpoint)).toEqual([
        external,
        'PJSIP/member-other'
      ]);
      const leg = originates(fakeAri).at(0);
      expect(leg?.callerId).toBe('+491230000');
      expect(leg?.variables?.['CALLERID(num)']).toBe('+491230000');
      expect(trunkState.activeChannels(trunkId)).toBe(1);

      const externalChannel = await channelTo(ari, external);
      const deviceChannel = await channelTo(ari, 'PJSIP/member-other');
      emit('ChannelStateChange', deviceChannel.id, { state: 'Up' });
      await finished;

      expect(call.status).toBe('answered');
      expect(call.answeredByUserId).toBe(other);
      expect(hangups(fakeAri, externalChannel.id)).toBe(1);
      emit('ChannelDestroyed', externalChannel.id, { cause: 16 });
      await eventually(() => {
        expect(trunkState.activeChannels(trunkId)).toBe(0);
      });
    });

    it('wins the batch when the external party answers', async () => {
      const forwarding = await seedUser(db);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId);
      const groupId = await seedRingGroup(db, [forwarding]);

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 1);
      const externalChannel = await channelTo(
        ari,
        `PJSIP/+15557777@trunk-${trunkId}`
      );
      // A member without a DID of their own presents the company main number (§9.4 "Caller-ID").
      expect(originates(fakeAri).at(0)?.callerId).toBe('+491110000');
      emit('ChannelStateChange', externalChannel.id, { state: 'Up' });
      await finished;

      expect(call.status).toBe('answered');
      expect(call.bridgeId).not.toBeNull();
      expect(hangups(fakeAri, externalChannel.id)).toBe(0);
    });

    it('falls through to the next route on a 503 before alerting, without the batch counting the leg ended', async () => {
      const forwarding = await seedUser(db);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      const trunk1 = await seedTrunk(db, 1);
      const trunk2 = await seedTrunk(db, 2);
      await seedRoute(db, 1, trunk1);
      await seedRoute(db, 2, trunk2);
      const groupId = await seedRingGroup(db, [forwarding]);

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 1);
      const first = await channelTo(ari, `PJSIP/+15557777@trunk-${trunk1}`);
      emit('ChannelDestroyed', first.id, {
        cause: AST_CAUSE_TEMPORARY_FAILURE
      });
      // The next route's attempt replaces the first as the member's leg.
      await membersRinging(call, 2);

      expect(originates(fakeAri).map(body => body.endpoint)).toEqual([
        `PJSIP/+15557777@trunk-${trunk1}`,
        `PJSIP/+15557777@trunk-${trunk2}`
      ]);
      expect(call.status).toBeNull();
      expect(trunkState.activeChannels(trunk1)).toBe(0);
      expect(trunkState.activeChannels(trunk2)).toBe(1);
      const second = await channelTo(ari, `PJSIP/+15557777@trunk-${trunk2}`);
      emit('ChannelStateChange', second.id, { state: 'Up' });
      await finished;

      expect(call.status).toBe('answered');
      expect(traceEvents(call).filter(event => event === 'attempt')).toEqual([
        'attempt',
        'attempt'
      ]);
    });

    it(
      'keeps ringing past 8s once the far end sent only 100 Trying, which no event reports',
      async () => {
        const forwarding = await seedUser(db);
        await seedExternalForward(db, forwarding, '+15557777');
        await seedDevice(db, forwarding, 'member-forwarding');
        const trunk1 = await seedTrunk(db, 1);
        const trunk2 = await seedTrunk(db, 2);
        await seedRoute(db, 1, trunk1);
        await seedRoute(db, 2, trunk2);
        const groupId = await seedRingGroup(db, [forwarding]);

        const finished = ringGroup(pipeline, call, groupId);
        await membersRinging(call, 1);
        const endpoint = `PJSIP/+15557777@trunk-${trunk1}`;
        const first = await channelTo(ari, endpoint);
        // chan_pjsip records every response in the channel's hangup-cause hash.
        fakeAri.channelVariables.set(
          `${first.id}:HANGUPCAUSE(${endpoint},tech)`,
          'SIP 100 Trying'
        );
        await sleep(ATTEMPT_NO_RESPONSE_MS + 300);

        expect(hangups(fakeAri, first.id)).toBe(0);
        expect(originates(fakeAri)).toHaveLength(1);
        emit('ChannelStateChange', first.id, { state: 'Up' });
        await finished;
        expect(call.status).toBe('answered');
      },
      ATTEMPT_NO_RESPONSE_MS + 5000
    );

    // §9.4 "Route fallthrough": the budget covers only the wait for a first response. An answer
    // landing while its end-of-budget read is still under way is the race's, never hung up.
    it(
      'keeps an attempt answered while its 8 s budget read is still under way',
      async () => {
        const forwarding = await seedUser(db);
        await seedExternalForward(db, forwarding, '+15557777');
        await seedDevice(db, forwarding, 'member-forwarding');
        const trunk1 = await seedTrunk(db, 1);
        await seedRoute(db, 1, trunk1);
        const groupId = await seedRingGroup(db, [forwarding]);
        // The read of the channel's hangup-cause hash is slow to answer.
        fakeAri.requestDelayMs = request =>
          request.method === 'GET' && request.path.endsWith('/variable')
            ? 600
            : 0;

        const finished = ringGroup(pipeline, call, groupId);
        await membersRinging(call, 1);
        const first = await channelTo(ari, `PJSIP/+15557777@trunk-${trunk1}`);
        await sleep(ATTEMPT_NO_RESPONSE_MS + 200);
        emit('ChannelStateChange', first.id, { state: 'Up' });
        await finished;
        // Past the read's own answer, which reports no provisional response.
        await sleep(800);

        expect(call.status).toBe('answered');
        expect(hangups(fakeAri, first.id)).toBe(0);
      },
      ATTEMPT_NO_RESPONSE_MS + 5000
    );

    it('falls through to the next route on a 403, which only tech_cause tells from a 603', async () => {
      const forwarding = await seedUser(db);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      const trunk1 = await seedTrunk(db, 1);
      const trunk2 = await seedTrunk(db, 2);
      await seedRoute(db, 1, trunk1);
      await seedRoute(db, 2, trunk2);
      const groupId = await seedRingGroup(db, [forwarding]);

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 1);
      const first = await channelTo(ari, `PJSIP/+15557777@trunk-${trunk1}`);
      emit('ChannelDestroyed', first.id, {
        cause: AST_CAUSE_CALL_REJECTED,
        techCause: 403
      });
      await membersRinging(call, 2);
      const second = await channelTo(ari, `PJSIP/+15557777@trunk-${trunk2}`);
      emit('ChannelStateChange', second.id, { state: 'Up' });
      await finished;

      expect(call.status).toBe('answered');
    });

    it('falls through to the next route on a 403 that ended the channel before its originate returned', async () => {
      const forwarding = await seedUser(db);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      const trunk1 = await seedTrunk(db, 1);
      const trunk2 = await seedTrunk(db, 2);
      await seedRoute(db, 1, trunk1);
      await seedRoute(db, 2, trunk2);
      const groupId = await seedRingGroup(db, [forwarding]);
      refuseFirstOriginate({ cause: AST_CAUSE_CALL_REJECTED, techCause: 403 });

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 2);
      const second = await channelTo(ari, `PJSIP/+15557777@trunk-${trunk2}`);
      emit('ChannelStateChange', second.id, { state: 'Up' });
      await finished;

      expect(call.status).toBe('answered');
    });

    it('is hung up when the caller hangs up while it rings', async () => {
      const forwarding = await seedUser(db);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId);
      const groupId = await seedRingGroup(db, [forwarding]);

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 1);
      const externalChannel = await channelTo(
        ari,
        `PJSIP/+15557777@trunk-${trunkId}`
      );
      emit('ChannelDestroyed', callerChannel.id, { cause: 16 });
      await finished;

      expect(hangups(fakeAri, externalChannel.id)).toBe(1);
    });

    it('is not rung when no route carries the member, and the group falls back', async () => {
      const forwarding = await seedUser(db);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      const someoneElse = await seedUser(db);
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId, someoneElse);
      const groupId = await seedRingGroup(db, [forwarding]);

      await ringGroup(pipeline, call, groupId);

      expect(originates(fakeAri)).toHaveLength(0);
      expect(traceEvents(call)).toContain('externalLegUnrouted');
      const released = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${callerChannel.id}` &&
          entry.qs === `reason_code=${sipToHangupCause(480)}`
      );
      expect(released).toBe(true);
    });
  });

  describe('a find-me leg', () => {
    function findMeLegs(): { channelId: string; state: string }[] {
      return [...call.legs.values()].filter(leg => leg.kind === 'findMe');
    }

    it("rings over the route's trunk as the user's own call alongside their device, and is hung up when the device answers", async () => {
      const didId = await seedDid(db, '+491230000');
      const userId = await seedUser(db, {
        calleridDidId: didId,
        findMe: [{ number: '+15557000', delayS: 0 }]
      });
      await seedDevice(db, userId, 'e101-d1');
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId, userId);

      const finished = ringUser(pipeline, call, userId);
      // The device leg and the find-me leg, each tracked once its originate returned.
      await eventually(() => {
        expect(call.legs.size).toBe(2);
      });

      expect(originates(fakeAri).map(body => body.endpoint)).toEqual([
        'PJSIP/e101-d1',
        `PJSIP/+15557000@trunk-${trunkId}`
      ]);
      expect(originates(fakeAri).at(1)?.callerId).toBe('+491230000');
      const findMe = findMeLegs().at(0);
      expect(findMe?.state).toBe('ringing');

      const device = await channelTo(ari, 'PJSIP/e101-d1');
      emit('ChannelStateChange', device.id, { state: 'Up' });
      await finished;

      expect(call.status).toBe('answered');
      expect(findMe?.state).toBe('ended');
      expect(hangups(fakeAri, findMe?.channelId ?? '')).toBe(1);
    });

    // §9.1 "every channel's language": the external party hears the accept prompt in it.
    it('is originated with the tenant’s language', async () => {
      await db.updateTable('settings').set({ language: 'de' }).execute();
      const userId = await seedUser(db, {
        findMe: [{ number: '+15557000', delayS: 0 }]
      });
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId);

      const finished = ringUser(pipeline, call, userId);
      await eventually(() => {
        expect(findMeLegs()).toHaveLength(1);
      });
      const leg = originates(fakeAri).find(
        body => body.endpoint === `PJSIP/+15557000@trunk-${trunkId}`
      );
      emit('ChannelDestroyed', callerChannel.id, { cause: 16 });
      await finished;

      expect(leg?.variables?.['CHANNEL(language)']).toBe('de');
    });

    /** The find-me leg of a user with one delay-0 entry, answered by the far end: it now awaits
     * its accept key (§10.1 step 4). */
    async function answeredFindMeLeg(): Promise<{
      channelId: string;
      finished: Promise<void>;
    }> {
      const userId = await seedUser(db, {
        findMe: [{ number: '+15557000', delayS: 0 }]
      });
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId);
      const finished = ringUser(pipeline, call, userId);
      const leg = await eventually(() => {
        const found = findMeLegs().at(0);
        if (found === undefined) {
          throw new Error('the find-me leg is not ringing yet');
        }
        return found;
      });
      emit('ChannelStateChange', leg.channelId, { state: 'Up' });
      await eventually(() => {
        expect(pipeline.pendingFindMeAccept.has(leg.channelId)).toBe(true);
      });
      return { channelId: leg.channelId, finished };
    }

    function dtmf(channelId: string, digit: string): void {
      fakeAri.emit({
        type: 'ChannelDtmfReceived',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: channelId, state: 'Up' }),
        digit
      });
    }

    it('plays the shipped accept prompt to the answering party, whose 1 wins the call', async () => {
      const { channelId, finished } = await answeredFindMeLeg();
      await eventually(() => {
        const play = fakeAri.calls.find(
          entry =>
            entry.method === 'POST' &&
            entry.path === `channels/${channelId}/play`
        );
        // core sounds' "press 1 to accept this call, or 2 to reject it" (§9.1 ships it).
        expect((play?.body as { media?: string } | undefined)?.media).toBe(
          'sound:followme/options'
        );
      });
      dtmf(channelId, '1');
      await finished;
      expect(call.status).toBe('answered');
      expect(hangups(fakeAri, channelId)).toBe(0);
    });

    it('drops the leg at once on 2, as the accept prompt offers', async () => {
      const { channelId } = await answeredFindMeLeg();
      dtmf(channelId, '2');
      await eventually(() => {
        expect(hangups(fakeAri, channelId)).toBe(1);
      });
      expect(call.status).not.toBe('answered');
      expect(pipeline.pendingFindMeAccept.has(channelId)).toBe(false);
      emit('ChannelDestroyed', callerChannel.id, { cause: 16 });
    });

    it('is hung up when the caller hangs up while it rings', async () => {
      const userId = await seedUser(db, {
        findMe: [{ number: '+15557000', delayS: 0 }]
      });
      await seedDevice(db, userId, 'e101-d1');
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId);

      const finished = ringUser(pipeline, call, userId);
      // The device leg and the find-me leg, each tracked once its originate returned.
      await eventually(() => {
        expect(call.legs.size).toBe(2);
      });
      const findMe = findMeLegs().at(0);
      emit('ChannelDestroyed', callerChannel.id, { cause: 16 });
      await finished;

      expect(findMe?.state).toBe('ended');
      expect(hangups(fakeAri, findMe?.channelId ?? '')).toBe(1);
    });

    it("falls through to the next route before alerting, keeping the ring race open, and ends it on the callee's busy", async () => {
      const userId = await seedUser(db, {
        findMe: [{ number: '+15557000', delayS: 0 }]
      });
      const trunk1 = await seedTrunk(db, 1);
      const trunk2 = await seedTrunk(db, 2);
      await seedRoute(db, 1, trunk1);
      await seedRoute(db, 2, trunk2);

      const finished = ringUser(pipeline, call, userId);
      const first = await eventually(() => {
        const leg = findMeLegs().at(0);
        if (leg === undefined) {
          throw new Error('the find-me leg is not ringing yet');
        }
        return leg;
      });
      emit('ChannelDestroyed', first.channelId, {
        cause: AST_CAUSE_TEMPORARY_FAILURE
      });
      // The second route's attempt replaces the first as the find-me leg once it is originated.
      await eventually(() => {
        expect(originates(fakeAri)).toHaveLength(2);
        const current = findMeLegs().at(0);
        expect(current).toBeDefined();
        expect(current?.channelId).not.toBe(first.channelId);
      });

      // The find-me leg was the race's only leg: it rings on over the second trunk.
      expect(pipeline.pendingRing.has(call.id)).toBe(true);
      const legs = findMeLegs();
      expect(legs).toHaveLength(1);
      const second = legs.at(0);
      expect(second?.channelId).not.toBe(first.channelId);
      expect(second?.state).toBe('ringing');
      expect(originates(fakeAri).map(body => body.endpoint)).toEqual([
        `PJSIP/+15557000@trunk-${trunk1}`,
        `PJSIP/+15557000@trunk-${trunk2}`
      ]);

      // 486 is the callee's own condition (§9.4 "Route fallthrough"): final, so the race ends.
      emit('ChannelDestroyed', second?.channelId ?? '', {
        cause: AST_CAUSE_USER_BUSY
      });
      await finished;
      expect(pipeline.pendingRing.has(call.id)).toBe(false);
      expect(originates(fakeAri)).toHaveLength(2);
    });

    it("ends the ring race on the callee's busy that ended the channel before its originate returned", async () => {
      const userId = await seedUser(db, {
        findMe: [{ number: '+15557000', delayS: 0 }]
      });
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId);
      refuseFirstOriginate({ cause: AST_CAUSE_USER_BUSY });

      await ringUser(pipeline, call, userId);

      expect(pipeline.pendingRing.has(call.id)).toBe(false);
      expect(findMeLegs().map(leg => leg.state)).toEqual(['ended']);
    });

    it('is not rung when no route carries the user, and the device rings on', async () => {
      const userId = await seedUser(db, {
        findMe: [{ number: '+15557000', delayS: 0 }]
      });
      await seedDevice(db, userId, 'e101-d1');
      const someoneElse = await seedUser(db);
      const trunkId = await seedTrunk(db, 1);
      await seedRoute(db, 1, trunkId, someoneElse);

      const finished = ringUser(pipeline, call, userId);
      // The find-me leg is judged unrouted (and traced) once the device leg rings.
      await eventually(() => {
        expect(call.legs.size).toBe(1);
        expect(traceEvents(call)).toContain('externalLegUnrouted');
      });

      expect(originates(fakeAri).map(body => body.endpoint)).toEqual([
        'PJSIP/e101-d1'
      ]);
      expect(findMeLegs()).toHaveLength(0);
      expect(pipeline.pendingRing.has(call.id)).toBe(true);
      const device = await channelTo(ari, 'PJSIP/e101-d1');
      emit('ChannelStateChange', device.id, { state: 'Up' });
      await finished;
      expect(call.status).toBe('answered');
      expect(traceEvents(call)).toContain('externalLegUnrouted');
    });
  });
});
