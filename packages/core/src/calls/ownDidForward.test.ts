import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedDid, seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { Channel } from '../ari/types.js';
import { AST_CAUSE_NORMAL_CLEARING } from '../sipCodes.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import {
  seedForwardTarget,
  seedRegisteredDevice,
  seedRoute,
  seedTrunk,
  seedUserWithDevice
} from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import { ringUser } from './ringUser.js';

// §10.1 step 7 with Outbound step 5: an external target that is one of the tenant's own DIDs is
// routed to that DID's target internally, counting a hop, and never leaves through a trunk.

const OWN_NUMBER = '+491110300';

describe('an external target that is an own DID (§10.1 step 7, Outbound step 5)', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;
  let callerChannel: Channel;
  let call: Call;

  async function endpoints(): Promise<string[]> {
    return (await ari.channels.list()).map(channel => channel.name);
  }

  function traceEvents(): string[] {
    return (call.log.finish().log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => String((JSON.parse(line) as { event?: string }).event));
  }

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline } = rig);
    fakeAri.answerAfterMs = 60_000;
    // A route that carries every number, so a target dialled out would show as a trunk channel.
    await seedRoute(db, await seedTrunk(db));
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
    await rig.stop();
  });

  it("a user's forward to an own DID rings the DID's target user, one hop on", async () => {
    const target = await seedUserWithDevice(rig, '202');
    await seedDid(
      db,
      OWN_NUMBER,
      await seedForwardTarget(db, { userId: target })
    );
    const forwarder = await seedUser(db, { mailboxEnabled: 0 });
    await db
      .insertInto('userForwardRules')
      .values({
        userId: forwarder,
        condition: 'unconditional',
        targetId: await seedForwardTarget(db, { external: OWN_NUMBER })
      })
      .execute();

    enterTarget(
      pipeline,
      call,
      { kind: 'user', userId: forwarder },
      null
    ).catch(() => undefined);

    await eventually(async () => {
      expect(await endpoints()).toContain('PJSIP/e202-a');
    });
    expect((await endpoints()).some(name => name.includes('@trunk-'))).toBe(
      false
    );
    expect(call.hops).toBe(1);
  });

  it('an own DID forwarding to itself ends at the hop limit, never dialled out', async () => {
    await seedDid(
      db,
      OWN_NUMBER,
      await seedForwardTarget(db, { external: OWN_NUMBER })
    );

    await enterTarget(
      pipeline,
      call,
      { kind: 'external', number: OWN_NUMBER },
      null
    );

    expect((await endpoints()).some(name => name.includes('@trunk-'))).toBe(
      false
    );
    expect(call.status).toBe('missed');
    expect(traceEvents()).toContain('hopLimit');
  });

  it('a find-me entry that is an own DID is not dialled out', async () => {
    await seedDid(db, OWN_NUMBER);
    const userId = await seedUser(db, {
      mailboxEnabled: 0,
      ringTimeoutS: 30,
      findMeJson: JSON.stringify([{ number: OWN_NUMBER, delayS: 0 }])
    });
    await seedRegisteredDevice(rig, userId, 'e101-d1');

    const finished = ringUser(pipeline, call, userId);
    await eventually(() => {
      expect([...call.legs.values()].some(leg => leg.state === 'ringing')).toBe(
        true
      );
    });
    const device = (await ari.channels.list()).find(
      channel => channel.name === 'PJSIP/e101-d1'
    );
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: device?.id ?? '', state: 'Down' }),
      cause: AST_CAUSE_NORMAL_CLEARING
    });
    await finished;

    expect((await endpoints()).some(name => name.includes('@trunk-'))).toBe(
      false
    );
    expect(traceEvents()).toContain('externalLegUnrouted');
  });
});
