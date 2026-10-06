import { describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from './runner.js';
import type { Actor } from './types.js';

import './dids/index.js';
import './ooo/index.js';
import './trunks/index.js';
import './users/index.js';

// The seeded user acting as a self-service `user` on their own scope.
const self: Actor = { id: 'owner', name: 'Owner', role: 'user' };

const RECORDED = { kind: 'external', external: '+4319999', record: true };

async function createDid(
  db: Db,
  target: Record<string, unknown>
): Promise<{ id: string; target: unknown }> {
  return runOperation(
    db,
    'dids.create',
    { number: '+4312345', target },
    asRun()
  ) as Promise<{ id: string; target: unknown }>;
}

function setForwarding(
  db: Db,
  target: Record<string, unknown>,
  actor?: Actor
): Promise<unknown> {
  return runOperation(
    db,
    'users.setForwarding',
    { id: 'owner', rules: [{ condition: 'unconditional', target }] },
    asRun(actor === undefined ? {} : { actor })
  );
}

/** The `forward_targets` row of the seeded user's one forwarding rule. */
function ruleTarget(db: Db): Promise<{ id: string; recordCalls: number }> {
  return db
    .selectFrom('userForwardRules')
    .innerJoin(
      'forwardTargets',
      'forwardTargets.id',
      'userForwardRules.targetId'
    )
    .select(['forwardTargets.id', 'forwardTargets.recordCalls'])
    .where('userForwardRules.userId', '=', 'owner')
    .executeTakeFirstOrThrow();
}

async function ruleFlag(db: Db): Promise<number> {
  return (await ruleTarget(db)).recordCalls;
}

// §10.2 "Recording semantics", §10.3 "Forward targets", §11.2 `forward_targets`.
describe('a forward target that records', () => {
  it('stores an admin-set flag on a sip or external target and reads it back, false when left out', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await createTrunk(db, { hosts: [{ host: 'sip.carrier.example' }] });
    const { trunk } = await createTrunk(db, {
      name: 'OpenAI',
      emergency: false,
      transport: 'tls',
      hosts: [{ host: 'sip.api.openai.com', direction: 'outbound' }]
    });
    const did = await createDid(db, {
      kind: 'sip',
      trunkId: trunk.id,
      user: 'proj_1',
      record: true
    });
    expect(did.target).toMatchObject({ kind: 'sip', record: true });
    const listed = (await runOperation(db, 'dids.list', {}, asRun())) as {
      items: { id: string; target: unknown }[];
    };
    expect(listed.items.find(item => item.id === did.id)).toMatchObject({
      target: { record: true }
    });
    await setForwarding(db, { kind: 'external', external: '+4319999' });
    expect(await ruleFlag(db)).toBe(0);
    expect(
      await runOperation(db, 'users.getForwarding', { id: 'owner' }, asRun())
    ).toMatchObject({
      rules: [{ target: { kind: 'external', record: false } }]
    });
  });

  it('refuses the flag on any other kind of target', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      createDid(db, { kind: 'user', userId: 'owner', record: true })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createDid(db, { kind: 'mailboxUser', userId: 'owner', record: false })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('is set by an admin alone: a user may only send the admin-set target back unchanged', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(setForwarding(db, RECORDED, self)).rejects.toMatchObject({
      status: 403
    });
    await expect(
      runOperation(
        db,
        'ooo.create',
        { scope: { kind: 'user', id: 'owner' }, target: RECORDED },
        asRun({ actor: self })
      )
    ).rejects.toMatchObject({ status: 403 });
    // Without the flag the number is the user's own business.
    await setForwarding(
      db,
      { kind: 'external', external: '+4319999', record: false },
      self
    );

    await setForwarding(db, RECORDED);
    const before = await ruleTarget(db);
    await setForwarding(db, RECORDED, self);
    expect(await ruleTarget(db)).toEqual(before);
    expect(before.recordCalls).toBe(1);
    await expect(
      setForwarding(db, { ...RECORDED, external: '+4318888' }, self)
    ).rejects.toMatchObject({ status: 403 });
  });
});
