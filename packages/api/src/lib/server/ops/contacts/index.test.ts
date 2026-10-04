import { describe, expect, it } from 'vitest';

import {
  asConfirmedRun,
  asRun,
  makeTestDb,
  seedSettings
} from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';

describe('contacts', () => {
  it('create normalizes a national number to E.164 on write', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const contact = (await runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Huber GmbH',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun()
    )) as { id: string; phones: unknown[] };
    expect(contact.phones).toEqual([{ label: 'work', number: '+4989123' }]);
  });

  it('update replaces the phone set as a whole when phones is present', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const contact = (await runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Huber GmbH',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun()
    )) as { id: string };
    await runOperation(
      db,
      'contacts.update',
      { id: contact.id, phones: [] },
      asRun()
    );
    const phones = await db
      .selectFrom('contactPhones')
      .selectAll()
      .where('contactId', '=', contact.id)
      .execute();
    expect(phones).toHaveLength(0);
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('entityId', '=', contact.id)
      .where('operation', '=', 'contacts.update')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    expect(changes.find(change => change.field === 'phones')).toMatchObject({
      from: [{ label: 'work', number: '+4989123' }],
      to: []
    });
  });

  it('refuses two phones that normalize to the same number, with a 422', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const attempt = runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Huber GmbH',
        phones: [
          { label: 'work', number: '089 123' },
          { label: 'mobile', number: '+4989123' }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('refuses two phones with the same label, with a 422', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const attempt = runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Huber GmbH',
        phones: [
          { label: 'work', number: '089 123' },
          { label: 'work', number: '089 456' }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('reads a contact, lists it and deletes it', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const contact = (await runOperation(
      db,
      'contacts.create',
      {
        displayName: 'Huber GmbH',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun()
    )) as { id: string };
    expect(
      await runOperation(db, 'contacts.get', { id: contact.id }, asRun())
    ).toEqual(contact);
    expect(await runOperation(db, 'contacts.list', {}, asRun())).toEqual({
      items: [contact],
      nextCursor: null
    });
    expect(
      await runOperation(
        db,
        'contacts.delete',
        { id: contact.id },
        asConfirmedRun()
      )
    ).toEqual({ id: contact.id });
  });
});
