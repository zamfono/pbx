import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { MAX_HOPS } from '../routing/targets.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedRingGroup } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import { Pipeline } from './pipeline.js';

// The mailbox a call ends in, recorded instead of deposited: no deposit is made here.
const { deposit } = vi.hoisted(() => ({
  deposit: vi.fn<(...args: unknown[]) => Promise<void>>()
}));
vi.mock('./voicemail.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./voicemail.js')>()),
  deposit
}));

describe('hop limit (§10.1 step 7)', () => {
  let rig: Rig;
  let db: Db;
  let pipeline: Pipeline;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, pipeline } = rig);
    deposit.mockReset();
    deposit.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rig.stop();
  });

  function makeCall(): Call {
    return newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: newId(),
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
  }

  it("ends in the last target's mailbox: a ring group reached after a user, whose callee is cleared", async () => {
    const firstUser = await seedUser(db, { mailboxEnabled: 1 });
    const nextUser = await seedUser(db, { mailboxEnabled: 1 });
    const groupId = await seedRingGroup(db, { mailboxEnabled: 1 });
    const nextTargetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: nextTargetId, userId: nextUser })
      .execute();
    // The group's own OOO rule forwards on to a user, the hop past the limit.
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeRingGroupId: groupId,
        active: 1,
        targetId: nextTargetId,
        createdAt: nowIso()
      })
      .execute();
    const call = makeCall();
    // An earlier hop targeted `firstUser`; its forward reached the group at the last hop.
    call.calleeUserId = firstUser;
    call.hops = MAX_HOPS;

    await enterTarget(
      pipeline,
      call,
      { kind: 'ringGroup', ringGroupId: groupId },
      null
    );

    expect(deposit.mock.calls.map(args => args[2])).toStrictEqual([
      { ringGroupId: groupId }
    ]);
    expect(call.calleeUserId).toBeNull();
  });
});
