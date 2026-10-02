import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton, required by phone-number normalization. */
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

describe('contacts', () => {
  it('create normalizes a national number to E.164 on write', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const contact = await runOperation<
      unknown,
      { id: string; phones: unknown[] }
    >(
      db,
      'contacts.create',
      {
        displayName: 'Huber GmbH',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun()
    );
    expect(contact.phones).toEqual([{ label: 'work', number: '+4989123' }]);
  });

  it('update replaces the phone set as a whole when phones is present', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const contact = await runOperation<unknown, { id: string }>(
      db,
      'contacts.create',
      {
        displayName: 'Huber GmbH',
        phones: [{ label: 'work', number: '089 123' }]
      },
      asRun()
    );
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
    await seedTenant(db);
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
    await seedTenant(db);
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
});
