import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';
import type { Actor } from '../types.js';

import '../audit/index.js';
import '../trunks/index.js';
import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.test';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton, required by extension and phone-number checks. */
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

/** A `user`-role account, returned as the actor it signs in as. */
async function createUser(
  db: Db,
  name: string,
  extension: string
): Promise<Actor> {
  const { user } = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    {
      name,
      email: `${extension}@x.test`,
      extension,
      role: 'user'
    },
    asRun()
  );
  return { id: user.id, name, role: 'user' };
}

/** An `ip` trunk a `sip` target can dial over (§9.4 "SIP targets"). */
async function createTrunk(db: Db): Promise<string> {
  const { trunk } = await runOperation<unknown, { trunk: { id: string } }>(
    db,
    'trunks.create',
    {
      name: 'OpenAI',
      emergency: true,
      authMode: 'ip',
      hosts: [{ host: 'sip.api.openai.com', direction: 'outbound' }]
    },
    asRun()
  );
  return trunk.id;
}

type Rule = { condition: string; target: Record<string, unknown> };

async function setForwarding(
  db: Db,
  id: string,
  rules: Rule[],
  actor: Actor = owner
): Promise<{ id: string; rules: Rule[] }> {
  return runOperation(
    db,
    'users.setForwarding',
    { id, rules },
    asRun({ actor })
  );
}

/** The stored rules' conditions, sorted, which each test compares against what it wrote. */
async function storedConditions(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('userForwardRules')
    .select('condition')
    .where('userId', '=', userId)
    .orderBy('condition')
    .execute();
  return rows.map(row => row.condition);
}

// §10.3 "Users": `PUT /users/{id}/forwarding` is self-service on the user's own id.
describe('users.setForwarding, self-service', () => {
  it('lets a user set their own rules to every non-sip kind, attributed to them in the audit log (§5.7)', async () => {
    const db = await seedTenant(await makeTestDb());
    const anna = await createUser(db, 'Anna Huber', '101');
    const ben = await createUser(db, 'Ben Roth', '102');
    const rules: Rule[] = [
      { condition: 'unconditional', target: { kind: 'user', userId: ben.id } },
      { condition: 'busy', target: { kind: 'mailboxUser', userId: anna.id } },
      {
        condition: 'noAnswer',
        target: { kind: 'external', external: '+4915112345678' }
      }
    ];
    const out = await setForwarding(db, anna.id, rules, anna);
    expect(out.rules).toEqual(rules);
    expect(await storedConditions(db, anna.id)).toEqual([
      'busy',
      'noAnswer',
      'unconditional'
    ]);
    const entry = await db
      .selectFrom('auditLog')
      .select(['actorUserId', 'actorUserName', 'channel', 'undoable'])
      .where('operation', '=', 'users.setForwarding')
      .where('entityId', '=', anna.id)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({
      actorUserId: anna.id,
      actorUserName: 'Anna Huber',
      channel: 'rest',
      undoable: 1
    });
  });

  it("refuses a user setting another user's forwarding with 403, as users.update does, and lets an admin", async () => {
    const db = await seedTenant(await makeTestDb());
    const anna = await createUser(db, 'Anna Huber', '101');
    const ben = await createUser(db, 'Ben Roth', '102');
    const rules: Rule[] = [
      { condition: 'busy', target: { kind: 'mailboxUser', userId: ben.id } }
    ];
    await expect(setForwarding(db, ben.id, rules, anna)).rejects.toMatchObject({
      status: 403
    });
    expect(await storedConditions(db, ben.id)).toEqual([]);
    const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };
    await setForwarding(db, ben.id, rules, admin);
    expect(await storedConditions(db, ben.id)).toEqual(['busy']);
  });

  it('refuses a sip target in a user’s own forwarding with 403 (§10.3 "Forward targets")', async () => {
    const db = await seedTenant(await makeTestDb());
    const anna = await createUser(db, 'Anna Huber', '101');
    const trunkId = await createTrunk(db);
    const attempt = setForwarding(
      db,
      anna.id,
      [
        {
          condition: 'noAnswer',
          target: { kind: 'sip', trunkId, user: 'proj_abc123' }
        }
      ],
      anna
    );
    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect(await storedConditions(db, anna.id)).toEqual([]);
  });

  it('refuses a user re-sending an admin-set sip rule unchanged, and removes one they leave out', async () => {
    const db = await seedTenant(await makeTestDb());
    const anna = await createUser(db, 'Anna Huber', '101');
    const trunkId = await createTrunk(db);
    const sipRule: Rule = {
      condition: 'noAnswer',
      target: { kind: 'sip', trunkId, user: 'proj_abc123' }
    };
    const busyRule: Rule = {
      condition: 'busy',
      target: { kind: 'mailboxUser', userId: anna.id }
    };
    await setForwarding(db, anna.id, [sipRule]);

    // The PUT replaces the set as a whole, so keeping the admin's rule means sending it back,
    // which is a `sip` target in the input: refused, as `ooo.update` refuses keeping one.
    await expect(
      setForwarding(db, anna.id, [sipRule, busyRule], anna)
    ).rejects.toMatchObject({ status: 403 });
    expect(await storedConditions(db, anna.id)).toEqual(['noAnswer']);

    // Leaving it out removes it, as any rule the PUT does not name.
    await setForwarding(db, anna.id, [busyRule], anna);
    expect(await storedConditions(db, anna.id)).toEqual(['busy']);
  });

  it("lets an admin undo a user's own forwarding change, restoring the rules it replaced (§5.8)", async () => {
    const db = await seedTenant(await makeTestDb());
    const anna = await createUser(db, 'Anna Huber', '101');
    const trunkId = await createTrunk(db);
    await setForwarding(db, anna.id, [
      {
        condition: 'noAnswer',
        target: { kind: 'sip', trunkId, user: 'proj_abc123' }
      }
    ]);
    await setForwarding(db, anna.id, [], anna);
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'users.setForwarding')
      .where('actorUserId', '=', anna.id)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', { id: entry.id }, asRun());
    expect(await storedConditions(db, anna.id)).toEqual(['noAnswer']);
  });
});
