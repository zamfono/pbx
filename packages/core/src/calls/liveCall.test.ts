import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newId,
  nowIso,
  openDb,
  type Db,
  type MailRequest
} from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { defaultChannel, type Logger } from '../ari/types.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { eventually } from '../testing/eventually.js';
import { newCall, type Call, type Leg } from './call.js';
import type { RingOutcome } from './legs.js';
import { closeCall } from './liveCall.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import type { ParticipationRecorder } from './recordParticipation.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe('closeCall', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let call: Call;
  /** What happened, in order: each QoS capture, recorder end and finish, with the hangups so far. */
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let trail: string[];

  function hangupsSoFar(): number {
    return fakeAri.calls.filter(
      entry => entry.method === 'DELETE' && entry.path.startsWith('channels/')
    ).length;
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    trail = [];
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    const cdr: PipelineDeps['cdr'] = {
      open: () => Promise.resolve(),
      noteQosLegs: () => {
        trail.push(`qos after ${hangupsSoFar()} hangups`);
      },
      finish: () => {
        trail.push('finish');
        return Promise.resolve();
      }
    };
    const recorder: ParticipationRecorder = {
      onCallerUp: () => Promise.resolve(),
      onLegUp: () => Promise.resolve(),
      onTransfereeUp: () => Promise.resolve(),
      onCallerEnded: (ended: Call) => {
        trail.push(
          `caller ${ended.callerChannelId} ended after ${hangupsSoFar()}`
        );
        return Promise.resolve();
      },
      onLegEnded: (_ended: Call, leg: Leg) => {
        trail.push(`leg ${leg.channelId} ended after ${hangupsSoFar()}`);
        return Promise.resolve();
      }
    };
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      cdr,
      recorder,
      now: nowIso,
      trunkState: null,
      presence: null
    });
    const caller = fakeAri.addChannel({ name: 'PJSIP/trunk-1-00000001' });
    const leg = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000002' });
    call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: caller.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.status = 'answered';
    call.legs.set(leg.id, {
      channelId: leg.id,
      kind: 'device',
      userId: null,
      state: 'up',
      endCause: null
    });
    pipeline.registerCall(call);
    pipeline.callByChannel.set(leg.id, call);
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('notes the QoS legs and ends each recorded participation of a call hung up over the API (§7, §10.2)', async () => {
    const [legId] = [...call.legs.keys()];

    await closeCall(pipeline, call, 'answered', true);

    expect(trail).toEqual([
      'qos after 0 hangups',
      `caller ${call.callerChannelId} ended after 0`,
      `leg ${legId} ended after 0`,
      'finish'
    ]);
    expect(hangupsSoFar()).toBe(2);
  });

  it('ends the recorded participations of a call a transfer closes, its channels left up', async () => {
    await closeCall(pipeline, call, 'answered', false);

    expect(trail).toContain(`caller ${call.callerChannelId} ended after 0`);
    expect(trail.at(0)).toBe('qos after 0 hangups');
    expect(hangupsSoFar()).toBe(0);
  });
});

describe('closeCall, on a call not yet answered', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let finished: (Call['status'] | null)[];
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let mails: MailRequest[];
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let userId: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, external: '+15550000' })
      .execute();
    const didId = newId();
    await db
      .insertInto('dids')
      .values({ id: didId, number: '+15551000', targetId, createdAt: nowIso() })
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
    userId = newId();
    await db
      .insertInto('users')
      .values({
        id: userId,
        name: 'Anna Huber',
        email: `${userId}@example.com`,
        createdAt: nowIso(),
        notifyMissedCalls: 1
      })
      .execute();
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    finished = [];
    mails = [];
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      cdr: {
        open: () => Promise.resolve(),
        finish: (ended: Call) => {
          finished.push(ended.status);
          return Promise.resolve();
        }
      },
      db,
      apiClient: {
        mail: request => {
          mails.push(request);
          return Promise.resolve();
        }
      },
      now: nowIso,
      trunkState: null,
      presence: null
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  function inboundCall(): Call {
    const caller = fakeAri.addChannel({ name: 'PJSIP/trunk-1-00000001' });
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: caller.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.calleeUserId = userId;
    pipeline.registerCall(call);
    return call;
  }

  it('sends the missed-call mail for a ringing inbound call hung up over the API (§10.2 "Mail")', async () => {
    const call = inboundCall();
    const outcome = new Promise<RingOutcome>(resolve => {
      const timer = setTimeout(() => undefined, 60_000);
      timer.unref();
      pipeline.pendingRing.set(call.id, {
        resolve,
        timer,
        existingBridgeId: null
      });
    });

    await closeCall(pipeline, call, 'missed', true);

    await expect(outcome).resolves.toBe('abandoned');
    expect(finished).toEqual(['missed']);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: 'missedCall', to: { userId } });
  });

  it('keeps the outcome and sends no mail for a call it already reached', async () => {
    const call = inboundCall();
    call.status = 'answered';

    await closeCall(pipeline, call, 'missed', true);

    expect(finished).toEqual(['answered']);
    expect(mails).toHaveLength(0);
  });

  it('only hangs up a caller in a voicemail deposit, which closes the row itself', async () => {
    const call = inboundCall();
    call.depositing = true;

    await closeCall(pipeline, call, 'missed', true);

    expect(finished).toEqual([]);
    expect(mails).toHaveLength(0);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${call.callerChannelId}`
      )
    ).toBe(true);
    // The caller's own end leaves the row to the deposit as well.
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: call.callerChannelId })
    });
    await eventually(() => {
      expect(call.callerEnded).toBe(true);
    });
    expect(finished).toEqual([]);
  });
});
