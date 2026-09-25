import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import type { Logger } from '../ari/types.js';
import { MAX_HOPS } from '../routing/targets.js';
import { newCall, type Call, type Owner } from './call.js';
import { enterTarget } from './inbound.js';
import {
  ConfigCache,
  EventBus,
  Pipeline,
  StateStore,
  type PipelineDeps
} from './pipeline.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function fakeCdr(): PipelineDeps['cdr'] {
  return { open: () => Promise.resolve(), finish: () => Promise.resolve() };
}

/** A throwaway forward-target/DID chain, just to satisfy `settings.main_did_id`'s FK. */
async function seedSettings(db: Db): Promise<void> {
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
}

async function seedUser(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Test User',
      email: `${id}@example.com`,
      mailboxEnabled: 1,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedRingGroup(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({
      id,
      name: `Group ${id}`,
      strategy: 'simultaneous',
      mailboxEnabled: 1,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

describe('hop limit (§10.1 step 7)', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let deposited: Owner[];

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
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
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      cdr: fakeCdr(),
      now: nowIso,
      trunkState: null,
      presence: null
    });
    deposited = [];
    pipeline.deposit = (_call, owner) => {
      deposited.push(owner);
      return Promise.resolve();
    };
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
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
    const firstUser = await seedUser(db);
    const nextUser = await seedUser(db);
    const groupId = await seedRingGroup(db);
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
      { id: newId(), kind: 'ringGroup', ringGroupId: groupId },
      null
    );

    expect(deposited).toStrictEqual([{ ringGroupId: groupId }]);
    expect(call.calleeUserId).toBeNull();
  });
});
