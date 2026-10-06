import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedUserWithDevice } from '../testing/seedRows.js';
import { newCall, type Call, type Leg } from './call.js';
import type { Pipeline } from './pipeline.js';
import { Recorder } from './recording.js';
import { transferCall } from './transfers.js';

// §10.2 "Recording semantics": a forward target that records records the trunk leg it answers on
// however the call reached it, so a trunk leg handed on by a transfer is recorded again, as its
// own participation, in the row it goes on in.

describe('a recording target leg handed on by a transfer (§10.1, §10.2)', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;
  let recorder: Recorder;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline } = rig);
    recorder = new Recorder({
      ari,
      cache: rig.cache,
      db,
      mediaDir: '/media',
      mix: () => Promise.resolve(0),
      log: noopLogger,
      now: nowIso
    });
    pipeline.deps.recorder = recorder;
  });

  afterEach(async () => {
    await rig.stop();
  });

  /** 101's answered call to an external target that records, its trunk leg recorded. */
  async function callToTarget(
    userId: string
  ): Promise<{ call: Call; callerId: string; trunk: Leg }> {
    const caller = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000002' });
    const trunkChannel = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000003'
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, caller.id);
    await ari.bridges.addChannel(bridge.id, trunkChannel.id);
    const call = newCall({
      id: newId(),
      direction: 'outbound',
      callerChannelId: caller.id,
      from: '101',
      to: '+15557777',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.callerUserId = userId;
    call.answeredAt = nowIso();
    call.status = 'answered';
    call.bridgeId = bridge.id;
    const trunk: Leg = {
      id: newId(),
      channelId: trunkChannel.id,
      kind: 'trunk',
      userId: null,
      state: 'up',
      endCause: null,
      targetRecords: true
    };
    call.legs.set(trunk.channelId, trunk);
    pipeline.registerCall(call);
    pipeline.callByChannel.set(trunk.channelId, call);
    await rig.cdr.open(call);
    await recorder.onLegUp(call, trunk);
    return { call, callerId: caller.id, trunk };
  }

  /** 101's answered consultation with 102, as an attended transfer finds it. */
  async function consultationWith(
    transferrerId: string,
    targetId: string
  ): Promise<{ consultation: Call; secondId: string }> {
    const second = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000004' });
    const targetLeg = fakeAri.addChannel({ name: 'PJSIP/e102-a-00000005' });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, second.id);
    await ari.bridges.addChannel(bridge.id, targetLeg.id);
    const consultation = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: second.id,
      from: '101',
      to: '102',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    consultation.callerUserId = transferrerId;
    consultation.calleeUserId = targetId;
    consultation.answeredByUserId = targetId;
    consultation.status = 'answered';
    consultation.bridgeId = bridge.id;
    consultation.legs.set(targetLeg.id, {
      id: newId(),
      channelId: targetLeg.id,
      kind: 'device',
      userId: targetId,
      state: 'up',
      endCause: null
    });
    pipeline.registerCall(consultation);
    pipeline.callByChannel.set(targetLeg.id, consultation);
    await rig.cdr.open(consultation);
    return { consultation, secondId: second.id };
  }

  function recordRequests(): typeof fakeAri.calls {
    return fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path.endsWith('/record')
    );
  }

  function snoopHungUp(entry: (typeof fakeAri.calls)[number]): boolean {
    return rig.hungUp(entry.path.slice('channels/'.length, -'/record'.length));
  }

  /** Finishes `entries`' snoop recordings, as Asterisk does once each snoop is hung up. */
  function finish(entries: typeof fakeAri.calls): void {
    for (const entry of entries) {
      fakeAri.emit({
        type: 'RecordingFinished',
        timestamp: nowIso(),
        application: 'zamfono',
        recording: { name: (entry.body as { name?: string }).name }
      });
    }
  }

  /** Waits for the trunk leg's participation in the original row to end with that row, which
   * closes once it is stored. */
  async function originalEnded(): Promise<void> {
    finish(
      await eventually(() => {
        const first = recordRequests().slice(0, 2);
        expect(first).toHaveLength(2);
        expect(first.every(snoopHungUp)).toBe(true);
        return first;
      })
    );
  }

  /** Waits for the trunk leg's participation in the row it goes on in, hangs it up and stores
   * it; the rows. */
  async function hangUpAndStore(
    trunkChannelId: string
  ): Promise<{ callId: string; userId: string | null }[]> {
    await eventually(() => {
      expect(recordRequests()).toHaveLength(4);
    });
    fakeAri.hangUpRemotely(trunkChannelId);
    finish(
      await eventually(() => {
        const onward = recordRequests().slice(2);
        expect(onward.every(snoopHungUp)).toBe(true);
        return onward;
      })
    );
    return eventually(async () => {
      const rows = await db
        .selectFrom('recordings')
        .select(['callId', 'userId'])
        .execute();
      expect(rows).toHaveLength(2);
      return rows;
    });
  }

  it('records it in the onward row of a blind transfer over the API', async () => {
    const transferrerId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    const { call, trunk } = await callToTarget(transferrerId);

    const transferred = transferCall(pipeline, call, {
      target: '102',
      actorUserId: transferrerId
    });
    await originalEnded();
    const child = await transferred;

    expect(await hangUpAndStore(trunk.channelId)).toEqual(
      expect.arrayContaining([
        { callId: call.id, userId: null },
        { callId: child.id, userId: null }
      ])
    );
  });

  it('records it in the onward row of a REFER blind transfer', async () => {
    const transferrerId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    const { call, callerId, trunk } = await callToTarget(transferrerId);

    fakeAri.emit({
      type: 'BridgeBlindTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: callerId, name: 'PJSIP/e101-a-00000002' },
      transferee: { id: trunk.channelId, name: 'PJSIP/trunk-1-00000003' },
      exten: '102',
      context: 'from-users',
      result: 'Success',
      is_external: false
    });
    await originalEnded();
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '102'],
      channel: {
        id: trunk.channelId,
        name: 'PJSIP/trunk-1-00000003',
        state: 'Up',
        caller: { number: '+15557777', name: '' },
        connected: { number: '', name: '' },
        dialplan: { context: 'from-users', exten: '102' }
      }
    });
    const child = await eventually(() => {
      const onward = pipeline.callByChannel.get(trunk.channelId);
      expect(onward?.status).toBe('answered');
      return onward;
    });

    expect(await hangUpAndStore(trunk.channelId)).toEqual(
      expect.arrayContaining([
        { callId: call.id, userId: null },
        { callId: child?.id, userId: null }
      ])
    );
  });

  it('records it in the consultation row an attended transfer hands it over to', async () => {
    const transferrerId = await seedUserWithDevice(rig, '101');
    const targetId = await seedUserWithDevice(rig, '102');
    const { call, callerId, trunk } = await callToTarget(transferrerId);
    const { consultation, secondId } = await consultationWith(
      transferrerId,
      targetId
    );
    const bridge2 = consultation.bridgeId ?? '';
    await ari.bridges.removeChannel(bridge2, secondId);
    await ari.bridges.addChannel(bridge2, trunk.channelId);

    fakeAri.emit({
      type: 'BridgeAttendedTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      transferer_first_leg: { id: callerId },
      transferer_second_leg: { id: secondId },
      transferee: { id: trunk.channelId },
      destination_type: 'bridge',
      destination_bridge: bridge2,
      result: 'Success'
    });
    await originalEnded();

    expect(await hangUpAndStore(trunk.channelId)).toEqual(
      expect.arrayContaining([
        { callId: call.id, userId: null },
        { callId: consultation.id, userId: null }
      ])
    );
  });
});
