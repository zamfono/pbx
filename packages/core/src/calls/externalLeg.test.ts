import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedDid, seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { Channel } from '../ari/types.js';
import { ATTEMPT_NO_RESPONSE_MS } from '../routing/trunk.js';
import { AST_CAUSE_CALL_REJECTED, AST_CAUSE_USER_BUSY } from '../sipCodes.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement, placedCallerId } from '../testing/ari/fakeDial.js';
import { eventually, flush } from '../testing/eventually.js';
import { registerDevice } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import {
  seedDevice,
  seedRingGroup,
  seedRoute,
  seedTrunk
} from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import { ringGroup } from './ringGroup.js';
import { ringUser } from './ringUser.js';
import type { TrunkState } from './trunkState.js';

// How long the fake Asterisk takes to answer the read of a channel's hangup-cause hash.
const SLOW_READ_MS = 600;
// Q.850 41, temporary failure (SIP 503), as ARI's `ChannelDestroyed` carries it.
const AST_CAUSE_TEMPORARY_FAILURE = 41;

/** A ring-race member: no mailbox, rung for 30 s. */
const MEMBER = { mailboxEnabled: 0, ringTimeoutS: 30 };
/** A member whose find-me list rings one external number at once. */
const FINDS_ME = {
  ...MEMBER,
  findMeJson: JSON.stringify([{ number: '+15557000', delayS: 0 }])
};

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

/** A ring group of `memberIds`, in that order, ringing 30 s. Returns its id. */
async function seedGroupOf(db: Db, memberIds: string[]): Promise<string> {
  const groupId = await seedRingGroup(db, { ringTimeoutS: 30 });
  await db
    .insertInto('ringGroupMembers')
    .values(
      memberIds.map((userId, position) => ({
        groupId,
        position,
        userId,
        userGroupId: null
      }))
    )
    .execute();
  return groupId;
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
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let trunkState: TrunkState;
  let pipeline: Pipeline;
  let callerChannel: Channel;
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
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline } = rig);
    trunkState = pipeline.deps.trunkState;
    fakeAri.answerAfterMs = 60_000;
    await db
      .updateTable('settings')
      .set({ mainDidId: await seedDid(db, '+491110000') })
      .execute();
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
    vi.useRealTimers();
    await rig.stop();
  });

  describe("a ring-group member's external forward", () => {
    it("rings over the route's trunk as the member's own call, alongside the other members, and is hung up when another member answers", async () => {
      const memberDidId = await seedDid(db, '+491230000');
      const forwarding = await seedUser(db, {
        ...MEMBER,
        callerIdDidId: memberDidId
      });
      await seedExternalForward(db, forwarding, '+15557777');
      // A member who forwards is still skipped while offline (§10.1 step 5).
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const other = await seedUser(db, MEMBER);
      await seedDevice(db, other, 'member-other');
      await registerDevice(fakeAri, pipeline, 'member-other');
      const trunkId = await seedTrunk(db, { priority: 1, authMode: 'ip' });
      await seedRoute(db, trunkId, { priority: 1 });
      const groupId = await seedGroupOf(db, [forwarding, other]);

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
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const trunkId = await seedTrunk(db, { priority: 1 });
      await seedRoute(db, trunkId, { priority: 1 });
      const groupId = await seedGroupOf(db, [forwarding]);

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
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const trunk1 = await seedTrunk(db, { priority: 1 });
      const trunk2 = await seedTrunk(db, { priority: 2 });
      await seedRoute(db, trunk1, { priority: 1 });
      await seedRoute(db, trunk2, { priority: 2 });
      const groupId = await seedGroupOf(db, [forwarding]);

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

    it('keeps ringing past 8s once the far end sent only 100 Trying, which no event reports', async () => {
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const trunk1 = await seedTrunk(db, { priority: 1 });
      const trunk2 = await seedTrunk(db, { priority: 2 });
      await seedRoute(db, trunk1, { priority: 1 });
      await seedRoute(db, trunk2, { priority: 2 });
      const groupId = await seedGroupOf(db, [forwarding]);
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
        shouldAdvanceTime: true
      });

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 1);
      const endpoint = `PJSIP/+15557777@trunk-${trunk1}`;
      const first = await channelTo(ari, endpoint);
      // chan_pjsip records every response in the channel's hangup-cause hash.
      fakeAri.channelVariables.set(
        `${first.id}:HANGUPCAUSE(${endpoint},tech)`,
        'SIP 100 Trying'
      );
      await vi.advanceTimersByTimeAsync(ATTEMPT_NO_RESPONSE_MS + 300);

      expect(hangups(fakeAri, first.id)).toBe(0);
      expect(originates(fakeAri)).toHaveLength(1);
      emit('ChannelStateChange', first.id, { state: 'Up' });
      await finished;
      expect(call.status).toBe('answered');
    });

    // §9.4 "Route fallthrough": the budget covers only the wait for a first response. An answer
    // landing while its end-of-budget read is still under way is the race's, never hung up.
    it('keeps an attempt answered while its 8 s budget read is still under way', async () => {
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const trunk1 = await seedTrunk(db, { priority: 1 });
      await seedRoute(db, trunk1, { priority: 1 });
      const groupId = await seedGroupOf(db, [forwarding]);
      // The read of the channel's hangup-cause hash is slow to answer.
      fakeAri.holdRequest = request =>
        request.method === 'GET' &&
        request.path.endsWith('/variable') &&
        request.qs.includes('HANGUPCAUSE')
          ? SLOW_READ_MS
          : 0;
      const getVariable = vi.spyOn(ari.channels, 'getVariable');
      const hangup = vi.spyOn(ari.channels, 'hangup');
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
        shouldAdvanceTime: true
      });

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 1);
      const endpoint = `PJSIP/+15557777@trunk-${trunk1}`;
      const first = await channelTo(ari, endpoint);
      await vi.advanceTimersByTimeAsync(ATTEMPT_NO_RESPONSE_MS);
      // Wrapped, so the wait ends at the read's start rather than its answer.
      const { read } = await eventually(() => {
        const index = getVariable.mock.calls.findIndex(
          ([channelId, name]) =>
            channelId === first.id && name === `HANGUPCAUSE(${endpoint},tech)`
        );
        expect(index).toBeGreaterThanOrEqual(0);
        return {
          read: getVariable.mock.results[index]?.value as Promise<unknown>
        };
      });
      emit('ChannelStateChange', first.id, { state: 'Up' });
      await finished;
      // Past the read's own answer, which reports no provisional response.
      await vi.advanceTimersByTimeAsync(SLOW_READ_MS);
      await read;
      await flush();

      expect(call.status).toBe('answered');
      expect(hangup).not.toHaveBeenCalledWith(first.id);
      expect(hangups(fakeAri, first.id)).toBe(0);
    });

    it('falls through to the next route on a 403, which only tech_cause tells from a 603', async () => {
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const trunk1 = await seedTrunk(db, { priority: 1 });
      const trunk2 = await seedTrunk(db, { priority: 2 });
      await seedRoute(db, trunk1, { priority: 1 });
      await seedRoute(db, trunk2, { priority: 2 });
      const groupId = await seedGroupOf(db, [forwarding]);

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
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const trunk1 = await seedTrunk(db, { priority: 1 });
      const trunk2 = await seedTrunk(db, { priority: 2 });
      await seedRoute(db, trunk1, { priority: 1 });
      await seedRoute(db, trunk2, { priority: 2 });
      const groupId = await seedGroupOf(db, [forwarding]);
      refuseFirstOriginate({ cause: AST_CAUSE_CALL_REJECTED, techCause: 403 });

      const finished = ringGroup(pipeline, call, groupId);
      await membersRinging(call, 2);
      const second = await channelTo(ari, `PJSIP/+15557777@trunk-${trunk2}`);
      emit('ChannelStateChange', second.id, { state: 'Up' });
      await finished;

      expect(call.status).toBe('answered');
    });

    it('is hung up when the caller hangs up while it rings', async () => {
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const trunkId = await seedTrunk(db, { priority: 1 });
      await seedRoute(db, trunkId, { priority: 1 });
      const groupId = await seedGroupOf(db, [forwarding]);

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
      const forwarding = await seedUser(db, MEMBER);
      await seedExternalForward(db, forwarding, '+15557777');
      await seedDevice(db, forwarding, 'member-forwarding');
      await registerDevice(fakeAri, pipeline, 'member-forwarding');
      const someoneElse = await seedUser(db, MEMBER);
      const trunkId = await seedTrunk(db, { priority: 1 });
      const routeId = await seedRoute(db, trunkId);
      await db
        .insertInto('outboundRouteUsers')
        .values({ routeId, userId: someoneElse })
        .execute();
      const groupId = await seedGroupOf(db, [forwarding]);

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
      const userId = await seedUser(db, { ...FINDS_ME, callerIdDidId: didId });
      await seedDevice(db, userId, 'e101-d1');
      await registerDevice(fakeAri, pipeline, 'e101-d1');
      const trunkId = await seedTrunk(db, { priority: 1 });
      const routeId = await seedRoute(db, trunkId);
      await db
        .insertInto('outboundRouteUsers')
        .values({ routeId, userId })
        .execute();

      const finished = ringUser(pipeline, call, userId);
      // The device leg and the find-me leg, each ringing once its dial is sent.
      await eventually(() => {
        const ringing = [...call.legs.values()].filter(
          leg => leg.state === 'ringing'
        );
        expect(ringing).toHaveLength(2);
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
      const userId = await seedUser(db, FINDS_ME);
      const trunkId = await seedTrunk(db, { priority: 1 });
      await seedRoute(db, trunkId, { priority: 1 });

      const finished = ringUser(pipeline, call, userId);
      await eventually(() => {
        expect(findMeLegs().map(found => found.state)).toEqual(['ringing']);
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
      finished: Promise<unknown>;
    }> {
      const userId = await seedUser(db, FINDS_ME);
      const trunkId = await seedTrunk(db, { priority: 1 });
      await seedRoute(db, trunkId, { priority: 1 });
      const finished = ringUser(pipeline, call, userId);
      const leg = await eventually(() => {
        const found = findMeLegs().at(0);
        if (found?.state !== 'ringing') {
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
      const userId = await seedUser(db, FINDS_ME);
      await seedDevice(db, userId, 'e101-d1');
      await registerDevice(fakeAri, pipeline, 'e101-d1');
      const trunkId = await seedTrunk(db, { priority: 1 });
      await seedRoute(db, trunkId, { priority: 1 });

      const finished = ringUser(pipeline, call, userId);
      // The device leg and the find-me leg, each ringing once its dial is sent.
      await eventually(() => {
        const ringing = [...call.legs.values()].filter(
          leg => leg.state === 'ringing'
        );
        expect(ringing).toHaveLength(2);
      });
      const findMe = findMeLegs().at(0);
      emit('ChannelDestroyed', callerChannel.id, { cause: 16 });
      await finished;

      expect(findMe?.state).toBe('ended');
      expect(hangups(fakeAri, findMe?.channelId ?? '')).toBe(1);
    });

    it("falls through to the next route before alerting, keeping the ring race open, and ends it on the callee's busy", async () => {
      const userId = await seedUser(db, FINDS_ME);
      const trunk1 = await seedTrunk(db, { priority: 1 });
      const trunk2 = await seedTrunk(db, { priority: 2 });
      await seedRoute(db, trunk1, { priority: 1 });
      await seedRoute(db, trunk2, { priority: 2 });

      const finished = ringUser(pipeline, call, userId);
      const first = await eventually(() => {
        const leg = findMeLegs().at(0);
        if (leg?.state !== 'ringing') {
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
      const userId = await seedUser(db, FINDS_ME);
      const trunkId = await seedTrunk(db, { priority: 1 });
      await seedRoute(db, trunkId, { priority: 1 });
      refuseFirstOriginate({ cause: AST_CAUSE_USER_BUSY });

      await ringUser(pipeline, call, userId);

      expect(pipeline.pendingRing.has(call.id)).toBe(false);
      expect(findMeLegs().map(leg => leg.state)).toEqual(['ended']);
    });

    it('is not rung when no route carries the user, and the device rings on', async () => {
      const userId = await seedUser(db, FINDS_ME);
      await seedDevice(db, userId, 'e101-d1');
      await registerDevice(fakeAri, pipeline, 'e101-d1');
      const someoneElse = await seedUser(db, MEMBER);
      const trunkId = await seedTrunk(db, { priority: 1 });
      const routeId = await seedRoute(db, trunkId);
      await db
        .insertInto('outboundRouteUsers')
        .values({ routeId, userId: someoneElse })
        .execute();

      const finished = ringUser(pipeline, call, userId);
      // The find-me leg is judged unrouted (and traced) once the device leg rings.
      await eventually(() => {
        expect([...call.legs.values()].map(leg => leg.state)).toEqual([
          'ringing'
        ]);
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
