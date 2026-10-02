import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { FakeAri } from '../ari/fake.js';
import { defaultChannel } from '../ari/fakeChannel.js';
import type { StateStore } from '../internal/stateStore.js';
import {
  AST_CAUSE_CALL_REJECTED,
  AST_CAUSE_NORMAL_CLEARING
} from '../sipCodes.js';
import { eventually } from '../testing/eventually.js';
import {
  answeredCall,
  legOf,
  startRig,
  type Rig
} from '../testing/pipelineRig.js';
import { seedDevice, seedUser } from '../testing/seedRows.js';
import { CallActions } from './actions.js';
import { callerChannel, newCall, type Call } from './call.js';
import { liveView } from './callState.js';
import type { GroupLeg } from './groupLegs.js';
import type { Pipeline } from './pipeline.js';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
// Over the action routes' 65536-byte body cap (actionRoutes.ts's `MAX_ACTION_BODY_BYTES`).
const OVERSIZED_BODY_BYTES = 65537;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const RING_TIMER_MS = 60_000;

/** A user at `ext` with one device, reported registered. */
async function seedUserWithDevice(rig: Rig, ext: string): Promise<string> {
  const id = await seedUser(rig.db, ext);
  await seedDevice(rig, id, `e${ext}-a`);
  return id;
}

describe('call control', () => {
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let rig: Rig;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let actions: CallActions;
  // eslint-disable-next-line init-declarations -- assigned by setUp() at the start of each test
  let state: StateStore;

  async function setUp(): Promise<void> {
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline, state } = rig);
    actions = new CallActions(pipeline);
  }

  afterEach(async () => {
    await rig.stop();
  });

  function requested(method: string, path: string, channel?: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === method &&
        entry.path === path &&
        (channel === undefined ||
          (entry.body as { channel?: string }).channel === channel)
    );
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
      cause: AST_CAUSE_NORMAL_CLEARING
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
    const memberId = await seedUserWithDevice(rig, '101');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
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
    const memberId = await seedUserWithDevice(rig, '101');
    await rig.devicesUp();
    const first = await answeredCall(rig, memberId);
    await actions.hold(first.id, { actorUserId: memberId });
    channelDestroyed(legOf(first));
    await eventually(() => {
      expect(rig.hungUp(callerChannel(first))).toBe(true);
    });

    const second = await answeredCall(rig, memberId);
    await actions.hold(second.id, { actorUserId: memberId });
    channelDestroyed(callerChannel(second));
    await eventually(() => {
      expect(rig.hungUp(legOf(second))).toBe(true);
    });
  });

  it('hangs up the held party with the call on a REST hangup', async () => {
    await setUp();
    const memberId = await seedUserWithDevice(rig, '101');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
    await actions.hold(call.id, { actorUserId: memberId });
    await actions.hangup(call.id, { actorUserId: memberId });
    expect(rig.hungUp(callerChannel(call))).toBe(true);
    expect(rig.hungUp(legOf(call))).toBe(true);
  });

  it('returns a held party to the bridge before a blind transfer moves it on', async () => {
    await setUp();
    const memberId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
    const bridgeId = call.bridgeId ?? '';
    await actions.hold(call.id, { actorUserId: memberId });
    await actions.transfer(call.id, { target: '102', actorUserId: memberId });
    expect(
      requested('POST', `bridges/${bridgeId}/addChannel`, callerChannel(call))
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
      // It has no caller channel: reachable by its id until it gets one or ends.
      expect(pipeline.channelless.get(callId)).toBe(consultation);
      return consultation;
    });
  }

  it('consults with the other party held, then transfers it to the consultation in the actor’s place', async () => {
    await setUp();
    const memberId = await seedUserWithDevice(rig, '101');
    const targetId = await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
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
    expect(rig.hungUp(actorChannel)).toBe(true);
    expect(consultation.parentCallId).toBe(call.id);
    expect(consultation.callerChannelId).toBe(call.callerChannelId);
    expect(pipeline.callByChannel.get(callerChannel(call))).toBe(consultation);
    expect(pipeline.channelless.size).toBe(0);
    // The history's caller stays the member; the live control is the parties' still in it.
    expect(consultation.callerUserId).toBe(memberId);
    expect(
      liveView(state.calls.get(consultation.id) ?? expect.unreachable())
        .connectedUserIds
    ).toEqual([targetId]);
    const original = await eventually(async () => {
      const row = await rowOf(call.id);
      expect(row?.endedAt).not.toBeNull();
      return row;
    });
    expect(original?.status).toBe('answered');
    expect(original?.log).toContain('"event":"attendedTransfer"');

    // The transferee hanging up ends the conversation and the consultation's row.
    channelDestroyed(callerChannel(call));
    await eventually(async () => {
      expect(rig.hungUp(targetLeg)).toBe(true);
      const row = await rowOf(consultation.id);
      expect(row?.endedAt).not.toBeNull();
      expect(row?.parentCallId).toBe(call.id);
    });
  });

  it('leaves the actor with the party still held when the consulted party hangs up', async () => {
    await setUp();
    const memberId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
    const consultation = await answeredConsultation(call, memberId);
    channelDestroyed(legOf(consultation));
    await eventually(async () => {
      expect((await rowOf(consultation.id))?.endedAt).not.toBeNull();
    });
    expect(pipeline.channelless.size).toBe(0);
    expect(rig.hungUp(legOf(call))).toBe(false);
    expect(rig.hungUp(callerChannel(call))).toBe(false);
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
    const memberId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
    const consultation = await answeredConsultation(call, memberId);
    channelDestroyed(legOf(call));
    await eventually(() => {
      expect(rig.hungUp(callerChannel(call))).toBe(true);
      expect(rig.hungUp(legOf(consultation))).toBe(true);
    });
    // The consulted party's channel, hung up, ends the consultation's row.
    channelDestroyed(legOf(consultation));
    await eventually(async () => {
      expect((await rowOf(consultation.id))?.endedAt).not.toBeNull();
    });
    expect(pipeline.channelless.size).toBe(0);
  });

  it('refuses a transfer to a call that is not the consultation, or not answered yet', async () => {
    await setUp();
    // The consultation below never answers.
    fakeAri.answerAfterMs = RING_TIMER_MS;
    const memberId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
    const other = await answeredCall(rig, memberId);
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
    const memberId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
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
    expect(pipeline.channelless.size).toBe(0);
    expect(rig.hungUp(callerChannel(call))).toBe(false);
  });

  it('lets go of an added party nobody answers, and of one a REST hangup ends while it rings', async () => {
    await setUp();
    fakeAri.answerAfterMs = RING_TIMER_MS;
    const memberId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);

    const declined = await actions.addParty(call.id, {
      target: '102',
      actorUserId: memberId
    });
    expect(pipeline.channelless.has(declined.callId)).toBe(true);
    const ringing = await eventually(() => {
      const leg = [...pipeline.callByChannel.entries()].find(
        ([, candidate]) => candidate.id === declined.callId
      );
      expect(leg).toBeDefined();
      return leg?.[0] ?? '';
    });
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: ringing }),
      cause: AST_CAUSE_CALL_REJECTED
    });
    await eventually(async () => {
      expect((await rowOf(declined.callId))?.status).toBe('missed');
    });
    expect(pipeline.channelless.size).toBe(0);

    const hungUp = await actions.addParty(call.id, {
      target: '102',
      actorUserId: memberId
    });
    await actions.hangup(hungUp.callId, { actorUserId: memberId });
    await eventually(async () => {
      expect((await rowOf(hungUp.callId))?.endedAt).not.toBeNull();
    });
    expect(pipeline.channelless.size).toBe(0);
  });

  it('declines the actor’s own ringing legs of a direct ring, and refuses 409 when none rings', async () => {
    await setUp();
    const memberId = await seedUserWithDevice(rig, '101');
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
    expect(call.legs.get(ringing.id)?.endCause).toBe(AST_CAUSE_CALL_REJECTED);
    // 603 is no busy: the ring settles as unanswered, for the user's noAnswer rule.
    expect(outcome).toBe('noAnswer');
    await eventually(() => {
      expect(rig.hungUp(ringing.id)).toBe(true);
    });
  });

  it('declines a ring-group member’s legs through the batch’s own race', async () => {
    await setUp();
    const memberId = await seedUserWithDevice(rig, '101');
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
    pipeline.activeBatches.set(call.id, {
      tracked,
      settle: () => undefined,
      endLeg: (leg, cause) => {
        leg.state = 'ended';
        ended.push([leg.channelId, cause]);
      }
    });
    actions.decline(call.id, { actorUserId: memberId });
    expect(ended).toEqual([[own.id, AST_CAUSE_CALL_REJECTED]]);
    expect(tracked.get(other.id)?.state).toBe('ringing');
    await eventually(() => {
      expect(rig.hungUp(own.id)).toBe(true);
    });
    expect(rig.hungUp(other.id)).toBe(false);
  });

  it('serves the call-control routes: 201 with the new call, 204, problems and 400', async () => {
    await setUp();
    const memberId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, memberId);
    const baseUrl = await rig.startServer(actions);
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}/internal/calls/${path}`, {
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
    const oversized = await post(`${call.id}/hold`, {
      actorUserId: memberId,
      pad: 'x'.repeat(OVERSIZED_BODY_BYTES)
    });
    expect(oversized.status).toBe(HTTP_BAD_REQUEST);
    await eventually(async () => {
      const resumed = await post(`${call.id}/resume`, {
        actorUserId: memberId
      });
      expect(resumed.status).toBe(HTTP_NO_CONTENT);
    });
  });
});
