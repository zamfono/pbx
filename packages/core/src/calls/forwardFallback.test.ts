import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SIP_HEADERS, newId, nowIso, type Db } from '@zamfono/shared';
import { seedDid, seedUser } from '@zamfono/shared/testDb.js';

import type { Channel } from '../ari/types.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';

// §10.1 step 7: an `external`, `sip` or `webSocket` target that does not work hands the call to
// its fallback; an `external` or `sip` one rings for its ring timeout at most.

// The mailbox a call ends in, recorded instead of deposited.
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

function sipTarget(
  trunkId: string,
  extra: Partial<Extract<ForwardTarget, { kind: 'sip' }>> = {}
): ForwardTarget {
  return {
    kind: 'sip',
    trunkId,
    user: 'agent',
    headers: [...DEFAULT_SIP_HEADERS],
    ...extra
  };
}

type Originate = { endpoint: string };

function trunkOriginates(fakeAri: FakeAri): Originate[] {
  return fakeAri.calls
    .filter(entry => isPlacement(entry))
    .map(entry => entry.body as Originate)
    .filter(body => body.endpoint.includes('@trunk-'));
}

function traceEvents(call: Call): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('forward-target fallbacks and ring timeouts (§10.1 step 7)', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let callerChannel: Channel;

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

  /** The leg the call rings now, once it rings. */
  function ringingLeg(call: Call): Promise<string> {
    return eventually(() => {
      const leg = [...call.legs.values()].find(
        entry => entry.state === 'ringing'
      );
      expect(leg).toBeDefined();
      return leg?.channelId ?? '';
    });
  }

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, pipeline } = rig);
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

  it('dials the fallback of a sip target whose trunk is gone', async () => {
    const backup = await seedSipTrunk(db, 'backup');
    const call = inboundCall();
    const started = enterTarget(
      pipeline,
      call,
      sipTarget(newId(), { fallback: sipTarget(backup) }),
      null
    );
    started.catch(() => undefined);

    const legs = await eventually(() => {
      const placed = trunkOriginates(fakeAri);
      expect(placed).toHaveLength(1);
      return placed;
    });
    expect(legs[0]?.endpoint).toBe(
      `PJSIP/agent@trunk-${backup}/sip:backup.example`
    );
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({
        event: 'fallback',
        from: 'sip',
        cause: 'trunkMissing',
        to: 'sip'
      })
    );
  });

  it('deposits in the fallback mailbox when the sip target answers busy', async () => {
    const trunkId = await seedSipTrunk(db, 'agent');
    const anna = await seedUser(db, { mailboxEnabled: 1 });
    const call = inboundCall();
    const started = enterTarget(
      pipeline,
      call,
      sipTarget(trunkId, { fallback: { kind: 'mailboxUser', userId: anna } }),
      null
    );
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: await ringingLeg(call) }),
      cause: AST_CAUSE_USER_BUSY,
      tech_cause: 486
    });
    await started;

    expect(deposit.mock.calls.map(args => args[2])).toStrictEqual([
      { userId: anna }
    ]);
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'fallback', cause: 486 })
    );
  });

  it('hangs up a target that rings past its ring timeout and releases 480 without a fallback', async () => {
    const trunkId = await seedSipTrunk(db, 'agent');
    const call = inboundCall();
    const started = enterTarget(
      pipeline,
      call,
      sipTarget(trunkId, { ringTimeoutS: 1 }),
      null
    );
    const legId = await ringingLeg(call);
    await started;

    expect(rig.hungUp(legId)).toBe(true);
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'attempt', cause: 'ringTimeout' })
    );
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'release', code: 480 })
    );
  });

  it('goes to the fallback once the ring timeout runs out', async () => {
    const trunkId = await seedSipTrunk(db, 'agent');
    const anna = await seedUser(db, { mailboxEnabled: 1 });
    const call = inboundCall();
    await enterTarget(
      pipeline,
      call,
      sipTarget(trunkId, {
        ringTimeoutS: 1,
        fallback: { kind: 'mailboxUser', userId: anna }
      }),
      null
    );

    expect(deposit.mock.calls.map(args => args[2])).toStrictEqual([
      { userId: anna }
    ]);
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'fallback', cause: 'ringTimeout' })
    );
  });

  it('counts a user fallback as a hop, against the hop limit the settings hold', async () => {
    const anna = await seedUser(db, { mailboxEnabled: 1 });
    const fallingBack = (): ForwardTarget =>
      sipTarget(newId(), { fallback: { kind: 'user', userId: anna } });

    const atDefault = inboundCall();
    atDefault.hops = 3;
    await enterTarget(pipeline, atDefault, fallingBack(), null);
    expect(traceEvents(atDefault)).toContainEqual(
      expect.objectContaining({ event: 'hopLimit', hops: 3 })
    );

    await db.updateTable('settings').set({ maxForwardHops: 4 }).execute();
    pipeline.deps.cache.invalidate();
    const raised = inboundCall();
    raised.hops = 3;
    await enterTarget(pipeline, raised, fallingBack(), null);
    expect(traceEvents(raised)).not.toContainEqual(
      expect.objectContaining({ event: 'hopLimit' })
    );
    expect(raised.hops).toBe(4);
  });

  it('never falls back for a call whose answer joins another bridge (*5)', async () => {
    const anna = await seedUser(db, { mailboxEnabled: 1 });
    const call = inboundCall();
    call.joinBridgeId = newId();
    await enterTarget(
      pipeline,
      call,
      sipTarget(newId(), { fallback: { kind: 'mailboxUser', userId: anna } }),
      null
    );

    expect(deposit).not.toHaveBeenCalled();
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'release', code: 503 })
    );
  });
});
