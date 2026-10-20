import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type CallLogLevel } from '@zamfono/shared';

import { newCall, type Call } from './calls/call.js';
import { transferCall } from './calls/transfers.js';
import { MediaTimeline } from './mediaTimeline.js';
import { eventually } from './testing/eventually.js';
import { noopLogger } from './testing/pipelineDeps.js';
import { answeredCall, startRig, type Rig } from './testing/pipelineRig.js';
import { seedUserWithDevice } from './testing/seedRows.js';

const AT = '2026-10-20T12:00:00.000Z';

/** An ARI that serves `variables` (`<channelId>:<name>`) and one bridge holding `inBridge`, and
 * counts the requests it gets. */
function stubAri(variables: Map<string, string>, inBridge: string[]) {
  const ari = {
    requests: 0,
    channels: {
      getVariable: (id: string, name: string) => {
        ari.requests += 1;
        return Promise.resolve(variables.get(`${id}:${name}`) ?? null);
      }
    },
    bridges: {
      list: () => {
        ari.requests += 1;
        return Promise.resolve([
          {
            id: 'b1',
            name: '',
            technology: 'simple_bridge',
            channels: inBridge
          }
        ]);
      }
    }
  };
  return ari;
}

function callAt(level: CallLogLevel): Call {
  return newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: 'caller',
    from: '+15559999',
    to: '101',
    startedAt: AT,
    logLevel: level,
    callLogMaxBytes: 1_048_576
  });
}

function mediaLines(call: Call): Record<string, unknown>[] {
  const { log } = call.log.finish();
  return (log === null ? [] : log.split('\n'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.event === 'media');
}

describe('MediaTimeline', () => {
  it('logs each sample with the packets since the previous one, the RTP addresses, SSRCs, encryption and hold, the formats and the bridge', async () => {
    const variables = new Map([
      ['caller:CHANNEL(rtcp,txcount)', '100'],
      ['caller:CHANNEL(rtcp,rxcount)', '90'],
      ['caller:CHANNEL(rtp,dest)', '203.0.113.5:4000'],
      ['caller:CHANNEL(rtp,src)', '10.0.0.2:10000'],
      ['caller:CHANNEL(rtcp,local_ssrc)', '1234567'],
      ['caller:CHANNEL(rtcp,remote_ssrc)', '7654321'],
      ['caller:CHANNEL(rtp,secure)', '1'],
      ['caller:CHANNEL(rtp,hold)', '0'],
      ['caller:CHANNEL(onhold)', '0'],
      ['caller:CHANNEL(audionativeformat)', '(g722)'],
      ['caller:CHANNEL(audioreadformat)', 'g722'],
      ['caller:CHANNEL(audiowriteformat)', 'alaw']
    ]);
    const timeline = new MediaTimeline(
      stubAri(variables, ['caller']),
      noopLogger,
      () => AT
    );
    const call = callAt('qos');
    timeline.track(call);

    await timeline.sample([call]);
    variables.set('caller:CHANNEL(rtcp,txcount)', '150');
    variables.set('caller:CHANNEL(rtcp,rxcount)', '90');
    await timeline.sample([call], 'ChannelLeftBridge');
    await timeline.settled(call);

    expect(mediaLines(call)).toEqual([
      {
        callId: call.id,
        event: 'media',
        at: AT,
        channelId: 'caller',
        sent: 100,
        received: 90,
        rtpSrc: '10.0.0.2:10000',
        rtpDest: '203.0.113.5:4000',
        localSsrc: '1234567',
        remoteSsrc: '7654321',
        secure: true,
        rtpHold: false,
        onHold: false,
        nativeFormat: 'g722',
        readFormat: 'g722',
        writeFormat: 'alaw',
        bridgeId: 'b1',
        bridgeTechnology: 'simple_bridge'
      },
      expect.objectContaining({
        on: 'ChannelLeftBridge',
        sent: 50,
        received: 0
      })
    ]);
  });

  it('ends the timeline of a channel that is gone without a sample or an error', async () => {
    const errors: unknown[] = [];
    const timeline = new MediaTimeline(
      stubAri(new Map(), []),
      { ...noopLogger, error: (...args: unknown[]) => errors.push(args) },
      () => AT
    );
    const call = callAt('qos');
    timeline.track(call);

    await timeline.sample([call]);
    await timeline.settled(call);

    expect(mediaLines(call)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('makes no ARI request for a call at level events, nor for one no longer open', async () => {
    const ari = stubAri(new Map(), ['caller']);
    const timeline = new MediaTimeline(ari, noopLogger, () => AT);
    const below = callAt('events');
    const closed = callAt('qos');
    timeline.track(below);
    timeline.track(closed);
    await timeline.settled(closed);

    await timeline.sample([below, closed]);

    expect(ari.requests).toBe(0);
  });

  it('samples every open call at qos on each tick, once its level is raised to it', async () => {
    const ari = stubAri(new Map(), ['caller']);
    const timeline = new MediaTimeline(ari, noopLogger, () => AT, 5);
    const call = callAt('events');
    timeline.track(call);
    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });
    expect(ari.requests).toBe(0);

    call.log.raise('qos');
    await eventually(() => {
      expect(ari.requests).toBeGreaterThan(0);
    });
    await timeline.settled(call);
    expect(mediaLines(call).length).toBeGreaterThan(0);
  });
});

describe('media timeline in a call', () => {
  let rig: Rig;

  afterEach(async () => {
    await rig.stop();
  });

  it('samples at once as a channel leaves a bridge', async () => {
    rig = await startRig();
    const userId = await seedUserWithDevice(rig, '101');
    const call = await answeredCall(rig, userId);
    call.log.raise('qos');
    const callerId = call.callerChannelId ?? '';

    rig.fakeAri.emit({
      type: 'ChannelLeftBridge',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: callerId, name: '' }
    });
    await rig.pipeline.idle();

    await eventually(() => {
      expect(call.log.finish().log).toContain(
        `"event":"media","on":"ChannelLeftBridge","at"`
      );
    });
  });

  it("logs the transferee's sample in the call it leaves and in its onward call", async () => {
    rig = await startRig();
    // The onward call takes the tenant's level, so the transferee's timeline goes on in it.
    await rig.db.updateTable('settings').set({ callLogLevel: 'qos' }).execute();
    rig.cache.invalidate();
    const transferrerId = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    const call = await answeredCall(rig, transferrerId, {
      legName: 'PJSIP/e101-a-00000002'
    });
    call.log.raise('qos');
    const callerId = call.callerChannelId ?? '';
    rig.fakeAri.channelVariables.set(`${callerId}:CHANNEL(rtcp,txcount)`, '7');

    const child = await transferCall(rig.pipeline, call, {
      target: '102',
      actorUserId: transferrerId
    });

    const parentRow = await rig.db
      .selectFrom('calls')
      .select('log')
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(parentRow.log).toContain(`"event":"media","on":"close","at"`);
    expect(parentRow.log).toContain(`"channelId":"${callerId}","sent":7`);
    await eventually(() => {
      expect(child.log.finish().log).toContain(`"on":"onward","at"`);
    });
  });
});
