import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { ConfigCache } from '../internal/snapshot.js';
import type { Pipeline } from './pipeline.js';
import { buildMemberStates } from './ringGroupState.js';

// `buildMemberStates` reads only presence and the calls in progress from the pipeline.
const idlePipeline = {
  deps: { presence: { isInCall: () => false } },
  callByChannel: new Map()
} as unknown as Pipeline;

async function seedUser(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Member',
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** A `settings` row plus the `dids` row its `mainDidId` FK requires; the snapshot needs one. */
async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+15551234', targetId, createdAt: nowIso() })
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
}

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
    db = openDb(':memory:');
    await migrateForTest(db);
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

    const states = buildMemberStates(
      idlePipeline,
      snapshot,
      groupId,
      nowIso(),
      new Set()
    );

    expect(
      states.map(state => [state.userId, state.oooInEffect])
    ).toStrictEqual([
      [present, false],
      [absent, true]
    ]);
  });
});
