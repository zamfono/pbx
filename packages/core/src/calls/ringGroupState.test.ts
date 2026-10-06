import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import {
  migratedTestDb,
  seedDid,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import { ConfigCache } from '../internal/snapshot.js';
import { ringable } from '../routing/ringGroup.js';
import { MAX_HOPS } from '../routing/targets.js';
import { seedForwardTarget } from '../testing/seedRows.js';
import type { Pipeline } from './pipeline.js';
import { buildMemberStates } from './ringGroupState.js';

// `buildMemberStates` reads only presence and the calls in progress from the pipeline.
const idlePipeline = {
  deps: { presence: { isInCall: () => false } },
  callByChannel: new Map(),
  channelless: new Map()
} as unknown as Pipeline;

async function seedOoo(db: Db, scopeUserId: string | null): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  await db
    .insertInto('oooRules')
    .values({
      id: newId(),
      scopeUserId,
      active: 1,
      targetId,
      createdAt: nowIso()
    })
    .execute();
}

describe('buildMemberStates', () => {
  let db: Db;

  beforeEach(async () => {
    db = await migratedTestDb();
    await seedSettings(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("skips a member only under their own in-effect OOO rule, not the tenant's (§10.1 step 5)", async () => {
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Sales',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    const present = await seedUser(db);
    const absent = await seedUser(db);
    await db
      .insertInto('ringGroupMembers')
      .values(
        [present, absent].map((userId, position) => ({
          groupId,
          position,
          userId,
          userGroupId: null
        }))
      )
      .execute();
    await seedOoo(db, null);
    await seedOoo(db, absent);
    const snapshot = await new ConfigCache(db).get();

    const states = buildMemberStates(idlePipeline, snapshot, groupId, {
      now: nowIso(),
      busy: new Set(),
      hops: 0
    });

    expect(
      states.map(state => [state.userId, state.oooInEffect])
    ).toStrictEqual([
      [present, false],
      [absent, true]
    ]);
  });

  it("follows a member's unconditional forward to an own DID to that DID's target (§10.1 step 5, Outbound step 5)", async () => {
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Sales',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    const member = await seedUser(db);
    const colleague = await seedUser(db);
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 0, userId: member, userGroupId: null })
      .execute();
    const colleagueTarget = newId();
    const didTarget = newId();
    await db
      .insertInto('forwardTargets')
      .values([
        { id: colleagueTarget, userId: colleague },
        { id: didTarget, external: '+491110300' }
      ])
      .execute();
    await seedDid(db, '+491110300', colleagueTarget);
    await db
      .insertInto('userForwardRules')
      .values({
        userId: member,
        condition: 'unconditional',
        targetId: didTarget
      })
      .execute();
    const snapshot = await new ConfigCache(db).get();

    const states = buildMemberStates(idlePipeline, snapshot, groupId, {
      now: nowIso(),
      busy: new Set(),
      hops: 0
    });

    expect(states.map(state => state.unconditional)).toStrictEqual([
      { kind: 'user', userId: colleague }
    ]);
  });
  /** A group whose one member forwards unconditionally to a chain of `dids` own DIDs, each
   * forwarding to the next, the last to a colleague; the group's id, the colleague's. */
  async function memberForwardingThroughDids(
    dids: number
  ): Promise<{ groupId: string; colleague: string }> {
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Sales',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    const member = await seedUser(db);
    const colleague = await seedUser(db);
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 0, userId: member, userGroupId: null })
      .execute();
    const numbers = [...Array(dids).keys()].map(
      index => `+49111030${String(index + 1)}`
    );
    const colleagueTarget = await seedForwardTarget(db, { userId: colleague });
    const numberTargets = await Promise.all(
      numbers.map(number => seedForwardTarget(db, { external: number }))
    );
    await Promise.all(
      numbers.map((number, index) =>
        seedDid(db, number, numberTargets[index + 1] ?? colleagueTarget)
      )
    );
    await db
      .insertInto('userForwardRules')
      .values({
        userId: member,
        condition: 'unconditional',
        targetId: numberTargets[0] ?? colleagueTarget
      })
      .execute();
    return { groupId, colleague };
  }

  it("follows a member's forward through own DIDs forwarding to each other to the last one's target (§10.1 step 5, step 7)", async () => {
    const { groupId, colleague } = await memberForwardingThroughDids(2);
    const snapshot = await new ConfigCache(db).get();

    const states = buildMemberStates(idlePipeline, snapshot, groupId, {
      now: nowIso(),
      busy: new Set(),
      hops: 0
    });

    expect(states.map(state => state.unconditional)).toStrictEqual([
      { kind: 'user', userId: colleague }
    ]);
  });

  it('skips a member whose forward through own DIDs passes the hop limit (§10.1 step 7)', async () => {
    const { groupId } = await memberForwardingThroughDids(MAX_HOPS);
    const snapshot = await new ConfigCache(db).get();

    const within = buildMemberStates(idlePipeline, snapshot, groupId, {
      now: nowIso(),
      busy: new Set(),
      hops: 0
    });
    const past = buildMemberStates(idlePipeline, snapshot, groupId, {
      now: nowIso(),
      busy: new Set(),
      hops: 1
    });

    expect(within.map(state => state.unconditional?.kind)).toStrictEqual([
      'user'
    ]);
    expect(ringable(past, true)).toStrictEqual([]);
  });
});
