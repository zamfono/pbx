import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type AfterCallReport, type Db } from '@zamfono/shared';
import { seedDid, seedUser } from '@zamfono/shared/testDb.js';

import type { Channel } from '../ari/types.js';
import { ConfigCache } from '../internal/snapshot.js';
import { findForwardTarget, type ForwardTarget } from '../routing/targets.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedForwardTarget } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import { CallsRecording } from './recordingSettle.js';

// §10.6 "After-call requests": each attempt of a forward target with an after-call request is
// noted on its call and reported to `api` once the call is over and its recordings are written.

const { deposit } = vi.hoisted(() => ({
  deposit: vi.fn<(...args: unknown[]) => Promise<void>>()
}));
vi.mock('./voicemail.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./voicemail.js')>()),
  deposit
}));

const CALLER = '+15559999';
// Q.850 17, user busy, which a 486 from the far end maps to.
const AST_CAUSE_USER_BUSY = 17;

async function seedSipTrunk(db: Db, name: string): Promise<string> {
  const trunkId = newId();
  await db
    .insertInto('trunks')
    .values({
      id: trunkId,
      name,
      priority: 1,
      emergency: 0,
      authMode: 'ip',
      transport: 'tls',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId,
      priority: 1,
      host: `${name}.example`,
      port: null,
      direction: 'outbound'
    })
    .execute();
  return trunkId;
}

/** Gives forward target `forwardTargetId` an after-call request, as `api` stores one. */
async function seedAfterCall(db: Db, forwardTargetId: string): Promise<void> {
  await db
    .insertInto('afterCallRequests')
    .values({
      id: newId(),
      forwardTargetId,
      method: 'POST',
      url: 'https://crm.example/calls',
      secretEnc: Buffer.from('x')
    })
    .execute();
}

describe('forward-target attempts', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let callerChannel: Channel;
  let reports: AfterCallReport[];
  let recordingsSettled: PromiseWithResolvers<undefined>;

  function inboundCall(): Call {
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: CALLER,
      to: '+15551077',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
    return call;
  }

  /** The target of row `id`, read as the pipeline reads the config. */
  async function targetOf(id: string): Promise<ForwardTarget> {
    return findForwardTarget(await new ConfigCache(db).get(), id);
  }

  beforeEach(async () => {
    reports = [];
    recordingsSettled = Promise.withResolvers();
    rig = await startRig({
      reports: {
        afterCall: report => {
          reports.push(report);
          return Promise.resolve();
        }
      }
    });
    ({ db, fakeAri, pipeline } = rig);
    pipeline.deps.recorder.settled = () => recordingsSettled.promise;
    fakeAri.answerAfterMs = 60_000;
    deposit.mockReset();
    deposit.mockResolvedValue(undefined);
    await db
      .updateTable('settings')
      .set({ mainDidId: await seedDid(db, '+15551000') })
      .execute();
    callerChannel = fakeAri.addChannel({
      caller: { number: CALLER, name: '' }
    });
  });

  afterEach(async () => {
    await rig.stop();
  });

  it('marks the targets that have an after-call request in the config snapshot', async () => {
    const withRequest = await seedForwardTarget(db, { external: '+15550001' });
    const without = await seedForwardTarget(db, { external: '+15550002' });
    await seedAfterCall(db, withRequest);
    expect(await targetOf(withRequest)).toMatchObject({
      afterCallOf: withRequest
    });
    expect(await targetOf(without)).not.toHaveProperty('afterCallOf');
  });

  it('reports every attempt of a fallback chain with its own outcome, once the recordings are written', async () => {
    const trunkId = await seedSipTrunk(db, 'agent');
    const anna = await seedUser(db, { mailboxEnabled: 1 });
    const busy = await seedForwardTarget(db, {
      sipTrunkId: trunkId,
      sipUser: 'agent',
      sipHeadersJson: '[]'
    });
    const invalid = await seedForwardTarget(db, {
      external: '+1555{{callerName}}x'
    });
    await seedAfterCall(db, busy);
    await seedAfterCall(db, invalid);
    const chain: ForwardTarget = {
      ...(await targetOf(invalid)),
      fallback: {
        ...(await targetOf(busy)),
        fallback: { kind: 'mailboxUser', userId: anna }
      }
    } as ForwardTarget;
    const call = inboundCall();

    const started = enterTarget(pipeline, call, chain, null);
    const ringing = await eventually(() => {
      const leg = [...call.legs.values()].find(
        entry => entry.state === 'ringing'
      );
      expect(leg).toBeDefined();
      return leg?.channelId ?? '';
    });
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: ringing }),
      cause: AST_CAUSE_USER_BUSY,
      tech_cause: 486
    });
    await started;

    expect(call.attempts).toMatchObject([
      {
        forwardTargetId: invalid,
        kind: 'external',
        outcome: 'failed',
        cause: 'templateInvalid'
      },
      {
        forwardTargetId: busy,
        kind: 'sip',
        trunkId,
        user: 'agent',
        outcome: 'failed',
        cause: 486,
        values: { callerNumber: CALLER, did: '+15551077', callId: call.id }
      }
    ]);

    // Nothing is reported while a recording of the call is still being written.
    await pipeline.finishCall(call);
    expect(reports).toEqual([]);
    recordingsSettled.resolve(undefined);
    await eventually(() => {
      expect(reports).toEqual([{ callId: call.id, attempts: call.attempts }]);
    });
  });

  it('reports nothing for a call that attempted no target with a request', async () => {
    const call = inboundCall();
    recordingsSettled.resolve(undefined);
    await enterTarget(pipeline, call, { kind: 'hangup' }, null);
    await pipeline.finishCall(call);
    await Promise.resolve();
    expect(reports).toEqual([]);
  });
});

describe('CallsRecording', () => {
  it('settles a call once its last participation is over, and at once for a call with none', async () => {
    const calls = new CallsRecording();
    await calls.settled('idle');
    calls.begin('c1');
    calls.begin('c1');
    calls.begin('c2');
    let settled = false;
    const waiting = calls.settled('c1').then(() => {
      settled = true;
    });
    calls.done('c1');
    calls.done('c2');
    await Promise.resolve();
    expect(settled).toBe(false);
    calls.done('c1');
    await waiting;
    expect(settled).toBe(true);
  });
});
