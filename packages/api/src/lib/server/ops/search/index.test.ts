import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/server/testDb.js';

import '../contacts/index.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
const user: Actor = { id: 'anna', name: 'Anna Huber', role: 'user' };
const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

function asRun(actor: Actor, overrides: Partial<RunInput> = {}): RunInput {
  return { actor, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds a user with a fixed extension and a contact, the fixtures every test in this file needs. */
async function seedFixtures(db: Db): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: 'anna',
      name: 'Anna Huber',
      email: 'ahuber@example.com',
      role: 'user',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('extensions')
    .values({ ext: '101', userId: 'anna' })
    .execute();
  await db
    .insertInto('users')
    .values({
      id: 'bob',
      name: 'Bob Nomatch',
      email: 'bobhub@example.com',
      role: 'user',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('extensions')
    .values({ ext: '102', userId: 'bob' })
    .execute();
  await runOperation(
    db,
    'contacts.create',
    { displayName: 'Huber GmbH' },
    asRun(owner)
  );
}

/** Seeds the tenant `settings` singleton, required by `contacts.create`'s phone normalization. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
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
}

type Item = { kind: string; id: string; label: string; matched: string };

describe('search', () => {
  it("finds a contact and a user by name, without matching a non-admin's e-mail", async () => {
    const db = await makeTestDb();
    await seedFixtures(db);
    const result = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: 'hub' },
      asRun(user)
    )) as { items: Item[] };
    expect(result.items).toContainEqual({
      kind: 'user',
      id: 'anna',
      label: 'Anna Huber · 101',
      matched: 'name'
    });
    expect(result.items).toContainEqual({
      kind: 'contact',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest types expect.any() as `any`
      id: expect.any(String),
      label: 'Huber GmbH',
      matched: 'name'
    });
    expect(result.items.some(item => item.id === 'bob')).toBe(false);
    expect(result.items.every(item => !('email' in item))).toBe(true);
  });

  it('also finds an e-mail-only match for an admin', async () => {
    const db = await makeTestDb();
    await seedFixtures(db);
    const result = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: 'hub' },
      asRun(admin)
    )) as { items: Item[] };
    expect(result.items).toContainEqual({
      kind: 'user',
      id: 'bob',
      label: 'Bob Nomatch · 102',
      matched: 'email'
    });
  });

  it('finds a contact by name and labels it with its first phone number', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const contact = (await runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Huber Consulting',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun(owner)
    )) as { id: string };
    const result = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: 'hub' },
      asRun(user)
    )) as { items: Item[] };
    expect(result.items).toContainEqual({
      kind: 'contact',
      id: contact.id,
      label: 'Huber Consulting · +4989123',
      matched: 'name'
    });
  });

  it('finds a contact by its normalized phone number', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const contact = (await runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Radiologie Nord',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun(owner)
    )) as { id: string };
    const result = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: '+4989123' },
      asRun(user)
    )) as { items: Item[] };
    expect(result.items).toContainEqual({
      kind: 'contact',
      id: contact.id,
      label: 'Radiologie Nord · +4989123',
      matched: 'phone'
    });
  });
});
