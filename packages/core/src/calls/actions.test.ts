import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTTP_CONFLICT,
  HTTP_CREATED,
  HTTP_NO_CONTENT,
  HTTP_NOT_FOUND,
  newId,
  nowIso,
  type Db
} from '@zamfono/shared';

import type { AriEvent } from '../ari/events.js';
import type { CdrWriter } from '../cdr.js';
import { SIP_ADDRESS_INCOMPLETE } from '../sipCodes.js';
import { type FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement, placedCallerId } from '../testing/ari/fakeDial.js';
import { eventually, flush } from '../testing/eventually.js';
import {
  answeredCall,
  languageSet,
  startRig,
  type Rig
} from '../testing/pipelineRig.js';
import {
  seedDevice,
  seedExternalRoute,
  seedUser
} from '../testing/seedRows.js';
import { CallActions } from './actions.js';
import { callerChannel, newCall, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';

const RING_TIMER_MS = 60_000;

type OriginateRecord = {
  endpoint?: string;
  appArgs?: string;
  channelId?: string;
  callerId?: string;
  variables?: Record<string, string>;
};

describe('CallActions', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let cdr: CdrWriter;
  let actions: CallActions;

  async function setUp(): Promise<void> {
    rig = await startRig();
    ({ db, fakeAri, pipeline, cdr } = rig);
    actions = new CallActions(pipeline);
  }

  afterEach(async () => {
    await rig.stop();
  });

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
      existingBridgeId: null,
      placing: 0
    });
    return call;
  }

  it('rings the user devices first, then dials the extension as that device would, with the actor in the trace', async () => {
    await setUp();
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await seedDevice(rig, callerId, 'e101-b');
    await rig.devicesUp();
    const calleeId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, calleeId, 'e102-a');
    await rig.devicesUp();
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
      expect(deviceChannelIds.filter(id => rig.hungUp(id))).toHaveLength(1);
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
      // Its answered device is its caller channel now, so it leaves the channel-less index.
      expect(pipeline.channelless.size).toBe(0);
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

  // §10.1 step 4: a ring settles only itself. The ring on the user's own phones hands its answer
  // over while another of their phones is still being placed; that placement ending (here refused)
  // must not conclude the call's next ring, the target's, as unanswered before its phone rang.
  it("a device still being placed once another answered never concludes the target's ring", async () => {
    await setUp();
    fakeAri.answerAfterMs = 60_000;
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await seedDevice(rig, callerId, 'e101-b');
    await rig.devicesUp();
    const calleeId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, calleeId, 'e102-a');
    await rig.devicesUp();
    // Read from the create itself: the dials complete out of order here.
    const channelOf = (endpoint: string): string =>
      (
        fakeAri.calls.find(
          entry =>
            entry.path === 'channels/create' &&
            (entry.body as { endpoint?: string }).endpoint === endpoint
        )?.body as { channelId?: string } | undefined
      )?.channelId ?? '';
    const answerArrived = Promise.withResolvers<undefined>();
    const targetRinging = Promise.withResolvers<undefined>();
    const targetDialAnswered = Promise.withResolvers<undefined>();
    const firstId = (): string => channelOf('PJSIP/e101-a');
    rig.ari.on('event', (event: AriEvent) => {
      if (
        event.type === 'ChannelStateChange' &&
        event.channel?.id === firstId()
      ) {
        answerArrived.resolve(undefined);
      }
    });
    fakeAri.holdRequest = request => {
      const created = request.body as { endpoint?: string } | undefined;
      if (
        request.path === 'channels/create' &&
        created?.endpoint === 'PJSIP/e101-b'
      ) {
        // Still being placed once the target's ring has begun.
        return targetRinging.promise;
      }
      const dialled = /^channels\/(?<id>[^/]+)\/dial$/u.exec(request.path);
      const channelId = dialled?.groups?.id ?? '';
      if (channelId === firstId()) {
        // Answered while its dial's response is still on the way.
        fakeAri.emit({
          type: 'ChannelStateChange',
          timestamp: nowIso(),
          application: 'zamfono',
          channel: defaultChannel({ id: channelId, state: 'Up' })
        });
        return answerArrived.promise;
      }
      if (channelId !== '' && channelId === channelOf('PJSIP/e102-a')) {
        // The target's ring has begun; the still-placing phone's dial is refused, and the
        // target's own dial answers only once that refusal has been handled.
        fakeAri.failDial = { status: 409, count: 1 };
        targetRinging.resolve(undefined);
        return targetDialAnswered.promise;
      }
      return 0;
    };
    const dial = vi.spyOn(rig.ari.channels, 'dial');
    const hangup = vi.spyOn(rig.ari.channels, 'hangup');
    // A dial's own promise, wrapped so a wait ends at the dial's start rather than its response.
    const dialOf = (
      endpoint: string
    ): Promise<{ dialling: Promise<unknown> }> =>
      eventually(() => {
        const index = dial.mock.calls.findIndex(
          ([channelId]) => channelId === channelOf(endpoint)
        );
        expect(index).toBeGreaterThanOrEqual(0);
        return {
          dialling: dial.mock.results[index]?.value as Promise<unknown>
        };
      });

    const originated = actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: newId(),
      requestId: 'req-1'
    });
    const refused = await dialOf('PJSIP/e101-b');
    await expect(refused.dialling).rejects.toMatchObject({ status: 409 });
    await flush();
    targetDialAnswered.resolve(undefined);
    // Past the dial's response, where a ring already over hangs the target's phone up.
    await (
      await dialOf('PJSIP/e102-a')
    ).dialling;
    await flush();

    const result = await originated;
    const callId = 'callId' in result ? result.callId : '';
    const targetId = channelOf('PJSIP/e102-a');
    const live = [...pipeline.callByChannel.values()].find(
      call => call.id === callId
    );
    expect(live?.log.finish().log ?? '').not.toContain('ringOutcome');
    expect(hangup).not.toHaveBeenCalledWith(targetId);
    expect(rig.hungUp(targetId)).toBe(false);
    await actions.hangup(callId, { actorUserId: newId() });
  });

  it('dials an external target through the user routes and trunks after the device answers', async () => {
    await setUp();
    pipeline.deps.trunkState = rig.trunkState();
    const trunkId = await seedExternalRoute(db);
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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
    pipeline.deps.trunkState = rig.trunkState();
    await seedExternalRoute(db, 'both');
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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
    const callerId = await seedUser(db, { ext: '101' });
    await db
      .updateTable('users')
      .set({
        logLevel: 'events',
        logLevelExpiresAt: '2999-01-01T00:00:00.000Z'
      })
      .where('id', '=', callerId)
      .execute();
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await seedDevice(rig, callerId, 'e101-b');
    await rig.devicesUp();
    const joinLeg = vi.spyOn(cdr.dialogs, 'joinLeg');

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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await seedDevice(rig, callerId, 'e101-b');
    await rig.devicesUp();

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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();
    const trail: string[] = [];
    const joinLeg = vi
      .spyOn(cdr.dialogs, 'joinLeg')
      .mockImplementation((_call, id) => {
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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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
    expect(pipeline.channelless.size).toBe(0);
  });

  it('keeps a click-to-dial reachable by its id while its phones ring, and lets go of it on a REST hangup', async () => {
    await setUp();
    fakeAri.answerAfterMs = 60_000;
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

    const result = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: callerId,
      requestId: 'req-hangup'
    });
    const callId = 'callId' in result ? result.callId : '';
    expect(pipeline.channelless.get(callId)?.callerChannelId).toBeNull();

    await actions.hangup(callId, { actorUserId: callerId });
    expect(pipeline.channelless.size).toBe(0);
    const row = await db
      .selectFrom('calls')
      .select(['status', 'endedAt'])
      .where('id', '=', callId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('missed');
    expect(row.endedAt).not.toBeNull();
    expect(originates().every(entry => rig.hungUp(entry.channelId ?? ''))).toBe(
      true
    );
  });

  it('answers 409 noRegisteredDevice when the user has devices but none is registered', async () => {
    await setUp();
    const userId = await seedUser(db, { ext: '101' });
    // A configured device that has never REGISTERed: §10.2 "Click-to-dial" turns on whether a
    // device can be rung, which a `devices` row alone does not settle.
    await seedDevice(rig, userId, 'e101-a', false);
    await rig.devicesUp();
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
    const userId = await seedUser(db, { ext: '101' });
    const actorUserId = newId();
    const baseUrl = await rig.startServer(actions);

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
    const userId = await seedUser(db, { ext: '101' });
    const call = await answeredCall(rig, userId);
    const actorUserId = newId();
    const baseUrl = await rig.startServer(actions);

    const response = await fetch(
      `${baseUrl}/internal/calls/${call.id}/hangup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorUserId })
      }
    );
    expect(response.status).toBe(HTTP_NO_CONTENT);
    expect(rig.hungUp(callerChannel(call))).toBe(true);
    for (const leg of call.legs.values()) {
      expect(rig.hungUp(leg.channelId)).toBe(true);
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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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

  it('picks up a ringing call by ringing the picker devices, the one that answers taking it, and refuses 409 notRinging otherwise', async () => {
    await setUp();
    const calleeId = await seedUser(db, { ext: '101' });
    const pickerId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, pickerId, 'e102-a');
    await seedDevice(rig, pickerId, 'e102-b');
    await rig.devicesUp();
    const ringing = ringingCall(calleeId);

    await actions.pickup(ringing.id, { actorUserId: pickerId });
    const dialled = originates();
    expect(dialled.map(entry => entry.endpoint)).toEqual([
      'PJSIP/e102-a',
      'PJSIP/e102-b'
    ]);
    // Both ring in a race of their own; the first to answer is the picked-up call's answer.
    const [first, second] = dialled.map(entry => entry.appArgs);
    expect(first).toMatch(/^leg,/u);
    expect(second).toBe(first);
    await eventually(() => {
      expect(ringing.answeredByUserId).toBe(pickerId);
      expect(ringing.legs.get(dialled[0]?.channelId ?? '')?.state).toBe('up');
      expect(rig.hungUp(dialled[1]?.channelId ?? '')).toBe(true);
    });
    expect(pipeline.pendingRing.has(ringing.id)).toBe(false);

    const answered = await answeredCall(rig, calleeId);
    await expect(
      actions.pickup(answered.id, { actorUserId: pickerId })
    ).rejects.toMatchObject({ status: HTTP_CONFLICT, reason: 'notRinging' });
    const nobodyId = await seedUser(db, { ext: '103' });
    const stillRinging = ringingCall(calleeId);
    await expect(
      actions.pickup(stillRinging.id, { actorUserId: nobodyId })
    ).rejects.toMatchObject({
      status: HTTP_CONFLICT,
      reason: 'noRegisteredDevice'
    });
    clearTimeout(pipeline.pendingRing.get(stillRinging.id)?.timer);
    await cdr.finish(ringing);
    const row = await db
      .selectFrom('calls')
      .select('log')
      .where('id', '=', ringing.id)
      .executeTakeFirstOrThrow();
    expect(row.log).toContain(
      `"event":"pickup","userId":"${pickerId}","ext":"101"`
    );
  });

  it('picks up the call it names while another call rings the same user (call waiting)', async () => {
    await setUp();
    const calleeId = await seedUser(db, { ext: '101' });
    const pickerId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, pickerId, 'e102-a');
    await rig.devicesUp();
    const waiting = ringingCall(calleeId);
    const named = ringingCall(calleeId);

    await actions.pickup(named.id, { actorUserId: pickerId });

    const [picker] = originates();
    await eventually(() => {
      expect(named.answeredByUserId).toBe(pickerId);
    });
    expect(named.legs.get(picker?.channelId ?? '')?.state).toBe('up');
    expect(pipeline.callByChannel.get(picker?.channelId ?? '')).toBe(named);
    expect(waiting.answeredAt).toBeNull();
    expect(pipeline.pendingRing.has(waiting.id)).toBe(true);
    expect(pipeline.pendingRing.has(named.id)).toBe(false);
    clearTimeout(pipeline.pendingRing.get(waiting.id)?.timer);
  });

  it('hangs up the answered phone of a pickup whose call stopped ringing meanwhile, and says so in its trace', async () => {
    await setUp();
    fakeAri.answerAfterMs = 60_000;
    const calleeId = await seedUser(db, { ext: '101' });
    const pickerId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, pickerId, 'e102-a');
    await rig.devicesUp();
    const ringing = ringingCall(calleeId);

    await actions.pickup(ringing.id, { actorUserId: pickerId });
    const [picker] = originates();
    clearTimeout(pipeline.pendingRing.get(ringing.id)?.timer);
    pipeline.pendingRing.delete(ringing.id);
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: picker?.channelId ?? '', state: 'Up' })
    });

    await eventually(() => {
      expect(rig.hungUp(picker?.channelId ?? '')).toBe(true);
    });
    expect(ringing.answeredAt).toBeNull();
    ringing.status = 'missed';
    await cdr.finish(ringing);
    const row = await db
      .selectFrom('calls')
      .select('log')
      .where('id', '=', ringing.id)
      .executeTakeFirstOrThrow();
    expect(row.log).toContain(
      `"event":"pickup","userId":"${pickerId}","result":"notRinging"`
    );
  });

  // §7 level `sip`: the picker's devices ring for the picked-up call, so their dialogs are its.
  it('joins every device it rings for a pickup to the picked-up call’s SIP capture', async () => {
    await setUp();
    const calleeId = await seedUser(db, { ext: '101' });
    const pickerId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, pickerId, 'e102-a');
    await seedDevice(rig, pickerId, 'e102-b');
    await rig.devicesUp();
    const ringing = ringingCall(calleeId);
    const joinLeg = vi.spyOn(cdr.dialogs, 'joinLeg');

    await actions.pickup(ringing.id, { actorUserId: pickerId });

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
    const calleeId = await seedUser(db, { ext: '101' });
    const pickerId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, pickerId, 'e102-a');
    await rig.devicesUp();
    const ringing = ringingCall(calleeId);

    await actions.pickup(ringing.id, { actorUserId: pickerId });
    // The ring's outcome settles in promise callbacks after the placement; let them run.
    await flush();
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
    const callerId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, callerId, 'e101-a');
    await rig.devicesUp();

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
    const calleeId = await seedUser(db, { ext: '101' });
    const pickerId = await seedUser(db, { ext: '102' });
    await seedDevice(rig, pickerId, 'e102-a');
    await rig.devicesUp();
    const ringing = ringingCall(calleeId);

    await actions.pickup(ringing.id, { actorUserId: pickerId });
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
    const userId = await seedUser(db, { ext: '101' });
    await seedDevice(rig, userId, 'e101-a');
    await rig.devicesUp();
    const baseUrl = await rig.startServer(actions);

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
