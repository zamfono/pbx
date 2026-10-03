import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';

import {
  AST_CAUSE_NORMAL_CLEARING,
  SIP_SERVICE_UNAVAILABLE
} from '../sipCodes.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { delivered } from '../testing/eventually.js';
import {
  answeredCall,
  legOf,
  startRig,
  type Rig
} from '../testing/pipelineRig.js';
import { seedUser } from '../testing/seedRows.js';
import { newCall } from './call.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { sipToHangupCause } from './releaseCause.js';

const SERVICE_UNAVAILABLE_CAUSE = String(
  sipToHangupCause(SIP_SERVICE_UNAVAILABLE)
);
const RING_TIMER_MS = 60_000;

describe('winding calls down as core stops', () => {
  let rig: Rig;

  afterEach(async () => {
    await rig.stop();
  });

  /** The `reason_code` of the core's hangup of `channelId`, `''` for none, `null` for no hangup. */
  function hangupCause(channelId: string): string | null {
    const request = rig.fakeAri.calls.find(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
    return request === undefined
      ? null
      : (new URLSearchParams(request.qs).get('reason_code') ?? '');
  }

  function rowOf(callId: string) {
    return rig.db
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', callId)
      .executeTakeFirstOrThrow();
  }

  it('releases a ringing caller with 503, hangs up its ringing legs and closes its row', async () => {
    rig = await startRig();
    const { fakeAri, pipeline, cdr } = rig;
    const userId = await seedUser(rig.db, '101');
    const caller = fakeAri.addChannel({});
    const ringing = fakeAri.addChannel({});
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
    call.legs.set(ringing.id, {
      channelId: ringing.id,
      kind: 'device',
      userId,
      state: 'ringing',
      endCause: null
    });
    await cdr.open(call);
    pipeline.registerCall(call);
    pipeline.callByChannel.set(ringing.id, call);
    const outcome = Promise.withResolvers<string>();
    const timer = setTimeout(() => undefined, RING_TIMER_MS);
    timer.unref();
    pipeline.pendingRing.set(call.id, {
      resolve: outcome.resolve,
      timer,
      existingBridgeId: null,
      placing: 0
    });

    await pipeline.drain();

    expect(hangupCause(caller.id)).toBe(SERVICE_UNAVAILABLE_CAUSE);
    expect(rig.hungUp(ringing.id)).toBe(true);
    expect(await outcome.promise).toBe('abandoned');
    const row = await rowOf(call.id);
    expect(row.status).toBe('failed');
    expect(row.endedAt).not.toBeNull();
    expect(pipeline.callByChannel.size).toBe(0);
  });

  it('hangs up an answered call with normal clearing and closes its row', async () => {
    rig = await startRig();
    const userId = await seedUser(rig.db, '101');
    const call = await answeredCall(rig, userId);

    await rig.pipeline.drain();

    expect(hangupCause(call.callerChannelId ?? '')).toBe(
      String(AST_CAUSE_NORMAL_CLEARING)
    );
    expect(rig.hungUp(legOf(call))).toBe(true);
    const row = await rowOf(call.id);
    expect(row.status).toBe('answered');
    expect(row.answeredAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();
  });

  it('ends the recorded participations of an answered call, as a hangup does', async () => {
    const recorder: ParticipationRecorder = {
      onCallerUp: vi.fn(),
      onLegUp: vi.fn(),
      onTransfereeUp: vi.fn(),
      onCallerEnded: vi.fn(() => Promise.resolve()),
      onLegEnded: vi.fn(() => Promise.resolve()),
      onLegMoved: vi.fn()
    };
    rig = await startRig({ recorder });
    const userId = await seedUser(rig.db, '101');
    const call = await answeredCall(rig, userId);
    const [leg] = call.legs.values();

    await rig.pipeline.drain();

    expect(recorder.onCallerEnded).toHaveBeenCalledWith(call);
    expect(recorder.onLegEnded).toHaveBeenCalledWith(call, leg);
  });

  it('releases a call arriving during the stop with 503', async () => {
    rig = await startRig();
    const { fakeAri, ari, pipeline } = rig;
    await pipeline.drain();
    const caller = fakeAri.addChannel({});
    const arrived = delivered(ari, 'StasisStart', caller.id);
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['inbound', '+15551000'],
      channel: defaultChannel({ id: caller.id })
    });
    await arrived;
    await pipeline.idle();

    expect(hangupCause(caller.id)).toBe(SERVICE_UNAVAILABLE_CAUSE);
    expect(await rig.db.selectFrom('calls').selectAll().execute()).toEqual([]);
  });
});
