import { describe, expect, it } from 'vitest';

import { DEFAULT_SIP_HEADERS, newId, nowIso, type Db } from '@zamfono/shared';

import { runPurge } from '../jobs/purge.js';
import { makeTestDb } from '../testDb.js';
import { runOperation, type RunInput } from './runner.js';
import type { Actor } from './types.js';

import './dids/index.js';
import './hours/index.js';
import './ooo/index.js';
import './trunks/index.js';
import './users/index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
// The seeded user acting as a self-service `user` on their own scope, as `ooo`'s tests do.
const self: Actor = { id: 'owner', name: 'Owner', role: 'user' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton, which the DID operations read, as `users`' tests do. */
async function seedTenant(db: Db): Promise<Db> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId
    })
    .execute();
  return db;
}

/** The OpenAI trunk, behind a carrier trunk that takes the catch-all route the first trunk gets
 * (§9.4 "Outbound routing"), so no route holds the one under test. */
async function createTrunk(db: Db): Promise<string> {
  await runOperation(
    db,
    'trunks.create',
    {
      name: 'Carrier',
      emergency: true,
      authMode: 'ip',
      hosts: [{ host: 'sip.carrier.example' }]
    },
    asRun()
  );
  const { trunk } = (await runOperation(
    db,
    'trunks.create',
    {
      name: 'OpenAI',
      emergency: false,
      authMode: 'ip',
      transport: 'tls',
      srtp: true,
      hosts: [{ host: 'sip.api.openai.com', port: 5061, direction: 'outbound' }]
    },
    asRun()
  )) as { trunk: { id: string } };
  return trunk.id;
}

function sipTarget(trunkId: string): Record<string, string> {
  return { kind: 'sip', trunkId, user: 'proj_abc123' };
}

async function createDid(
  db: Db,
  target: Record<string, string>
): Promise<{ id: string; target: unknown }> {
  return runOperation(
    db,
    'dids.create',
    { number: '+4312345', target },
    asRun()
  ) as Promise<{ id: string; target: unknown }>;
}

async function deleteTrunk(db: Db, id: string): Promise<unknown> {
  return runOperation(db, 'trunks.delete', { id }, asRun({ confirm: true }));
}

// §9.4 "SIP targets", §10.3 "Forward targets", §11.2 `forward_targets`.
describe('sip forward targets', () => {
  it('stores a sip target in its column pair and reads it back in the wire shape', async () => {
    const db = await seedTenant(await makeTestDb());
    const trunkId = await createTrunk(db);
    const did = await createDid(db, sipTarget(trunkId));
    // A write without headers gets the defaults, which every read returns (§10.3).
    const stored = { ...sipTarget(trunkId), headers: DEFAULT_SIP_HEADERS };
    expect(did.target).toEqual(stored);
    const row = await db
      .selectFrom('dids')
      .innerJoin('forwardTargets', 'forwardTargets.id', 'dids.targetId')
      .select([
        'forwardTargets.sipTrunkId',
        'forwardTargets.sipUser',
        'forwardTargets.external'
      ])
      .where('dids.id', '=', did.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      sipTrunkId: trunkId,
      sipUser: 'proj_abc123',
      external: null
    });
    const listed = (await runOperation(db, 'dids.list', {}, asRun())) as {
      items: { target: unknown }[];
    };
    expect(listed.items.map(item => item.target)).toContainEqual(stored);
  });

  it('refuses a user part outside the safe subset, and a trunk that is not live', async () => {
    const db = await seedTenant(await makeTestDb());
    const trunkId = await createTrunk(db);
    for (const user of ['', 'a@b', 'a/b', 'a;b', 'a b', 'x'.repeat(65)]) {
      // eslint-disable-next-line no-await-in-loop -- each user part is refused on its own
      await expect(
        createDid(db, { kind: 'sip', trunkId, user })
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(
      createDid(db, { kind: 'sip', trunkId: 'nope', user: 'proj_1' })
    ).rejects.toMatchObject({ status: 404 });
    await deleteTrunk(db, trunkId);
    await expect(createDid(db, sipTarget(trunkId))).rejects.toMatchObject({
      status: 404
    });
  });

  it('lets an admin set a sip target on a user, and refuses a user who sets or keeps one', async () => {
    const db = await seedTenant(await makeTestDb());
    const trunkId = await createTrunk(db);
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: 'owner',
        rules: [{ condition: 'unconditional', target: sipTarget(trunkId) }]
      },
      asRun()
    );
    const ooo = (await runOperation(
      db,
      'ooo.create',
      { scope: { kind: 'user', id: 'owner' }, target: sipTarget(trunkId) },
      asRun()
    )) as { id: string };

    // Creating one: an OOO rule, an opening-hours schedule.
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'user', id: 'owner' },
          active: false,
          target: sipTarget(trunkId)
        },
        asRun({ actor: self })
      )
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runOperation(
        db,
        'hours.set',
        {
          scope: { kind: 'user', id: 'owner' },
          closedTarget: sipTarget(trunkId),
          intervals: []
        },
        asRun({ actor: self })
      )
    ).rejects.toMatchObject({ status: 403 });
    // Keeping one: an update that leaves the admin's target in place.
    await expect(
      runOperation(
        db,
        'ooo.update',
        { id: ooo.id, active: false },
        asRun({ actor: self })
      )
    ).rejects.toMatchObject({ status: 403 });
    // Replacing it with another kind is the user's own business.
    const replaced = (await runOperation(
      db,
      'ooo.update',
      {
        id: ooo.id,
        target: { kind: 'mailboxUser', userId: 'owner' }
      },
      asRun({ actor: self })
    )) as { target: unknown };
    expect(replaced.target).toEqual({ kind: 'mailboxUser', userId: 'owner' });
  });

  it('refuses to delete a trunk a live sip target dials over, listing its owners, until retargeted', async () => {
    const db = await seedTenant(await makeTestDb());
    const trunkId = await createTrunk(db);
    const did = await createDid(db, sipTarget(trunkId));
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: 'owner',
        rules: [{ condition: 'busy', target: sipTarget(trunkId) }]
      },
      asRun()
    );
    await expect(deleteTrunk(db, trunkId)).rejects.toMatchObject({
      status: 409,
      detail: {
        references: [
          { kind: 'did', id: did.id, label: '+4312345' },
          { kind: 'user', id: 'owner', label: 'forwarding rule (busy)' }
        ]
      }
    });
    await runOperation(
      db,
      'dids.update',
      { id: did.id, target: { kind: 'external', external: '+4399' } },
      asRun()
    );
    await runOperation(
      db,
      'users.setForwarding',
      { id: 'owner', rules: [] },
      asRun()
    );
    await deleteTrunk(db, trunkId);
    const row = await db
      .selectFrom('trunks')
      .select('deletedAt')
      .where('id', '=', trunkId)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).not.toBeNull();
  });

  it('keeps a soft-deleted trunk from the purge while a soft-deleted owner’s sip target names it', async () => {
    const db = await seedTenant(await makeTestDb());
    const trunkId = await createTrunk(db);
    await db
      .insertInto('users')
      .values({ id: 'u2', name: 'AI', email: 'ai@x', createdAt: nowIso() })
      .execute();
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: 'u2',
        rules: [{ condition: 'unconditional', target: sipTarget(trunkId) }]
      },
      asRun()
    );
    const longAgo = '2000-01-01T00:00:00.000Z';
    const recently = nowIso();
    // The trunk was deleted first and is due; the user, deleted since, is not yet.
    await db
      .updateTable('trunks')
      .set({ deletedAt: longAgo })
      .where('id', '=', trunkId)
      .execute();
    await db
      .updateTable('users')
      .set({ deletedAt: recently })
      .where('id', '=', 'u2')
      .execute();

    await runPurge(db, nowIso());
    const kept = await db
      .selectFrom('trunks')
      .select('id')
      .where('id', '=', trunkId)
      .execute();
    expect(kept).toHaveLength(1);

    await db
      .updateTable('users')
      .set({ deletedAt: longAgo })
      .where('id', '=', 'u2')
      .execute();
    await runPurge(db, nowIso());
    const purged = await db
      .selectFrom('trunks')
      .select('id')
      .where('id', '=', trunkId)
      .execute();
    expect(purged).toEqual([]);
  });
});
