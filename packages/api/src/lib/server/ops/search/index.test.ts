import { describe, expect, it } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';

import { asRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import '../contacts/index.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const user: Actor = { id: 'anna', name: 'Anna Huber', role: 'user' };
const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

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
    asRun()
  );
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
      asRun({ actor: user })
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
      matched: 'displayName'
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
      asRun({ actor: admin })
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
    await seedSettings(db);
    const contact = (await runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Huber Consulting',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun()
    )) as { id: string };
    const result = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: 'hub' },
      asRun({ actor: user })
    )) as { items: Item[] };
    expect(result.items).toContainEqual({
      kind: 'contact',
      id: contact.id,
      label: 'Huber Consulting · +4989123',
      matched: 'displayName'
    });
  });

  it('finds a contact by its normalized phone number', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const contact = (await runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Radiologie Nord',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun()
    )) as { id: string };
    const result = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: '+4989123' },
      asRun({ actor: user })
    )) as { items: Item[] };
    expect(result.items).toContainEqual({
      kind: 'contact',
      id: contact.id,
      label: 'Radiologie Nord · +4989123',
      matched: 'phones'
    });
  });

  it.each(['+49 89 123', '089 123', '(089) 12', '89-123'])(
    'finds a contact by the pasted number %s',
    async pasted => {
      const db = await makeTestDb();
      await seedSettings(db);
      const contact = (await runOperation(
        db,
        'contacts.create',
        {
          displayName: 'Radiologie Nord',
          phones: [{ label: 'work', number: '089 123' }]
        },
        asRun()
      )) as { id: string };
      const result = (await runOperation(
        db,
        'search.query',
        // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
        { q: pasted },
        asRun({ actor: user })
      )) as { items: Item[] };
      expect(result.items).toContainEqual(
        expect.objectContaining({ id: contact.id, matched: 'phones' })
      );
    }
  );

  it('names the wire field a user matched on and pages the hits', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedFixtures(db);
    type Page = { items: Item[]; nextCursor: string | null };
    const first = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: '10', limit: 1 },
      asRun({ actor: user })
    )) as Page;
    const second = (await runOperation(
      db,
      'search.query',
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      { q: '10', limit: 1, cursor: first.nextCursor },
      asRun({ actor: user })
    )) as Page;
    expect([...first.items, ...second.items]).toEqual([
      {
        kind: 'user',
        id: 'anna',
        label: 'Anna Huber · 101',
        matched: 'extension'
      },
      {
        kind: 'user',
        id: 'bob',
        label: 'Bob Nomatch · 102',
        matched: 'extension'
      }
    ]);
    expect(second.nextCursor).toBeNull();
  });
});
