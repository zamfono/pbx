import { describe, expect, it, vi } from 'vitest';

import { asRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { runOperation } from './runner.js';

import './contacts/index.js';
import './users/index.js';

vi.mock('#lib/server/mail/index.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/mail/index.js')>();
  return { ...actual, sendMail: vi.fn(() => Promise.resolve('sent')) };
});

describe('confirmation questions (§10.3 "Confirmation")', () => {
  it('name what goes and how long its deletion can be undone, from settings', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { softDeleteRetentionDays: 3 });
    const { user } = (await runOperation(
      db,
      'users.create',
      { name: 'Anna Huber', email: 'anna@example.com', extension: '101' },
      asRun()
    )) as { user: { id: string } };
    await expect(
      runOperation(db, 'users.delete', { id: user.id }, asRun())
    ).rejects.toMatchObject({
      status: 409,
      question:
        'Delete Anna Huber (extension 101)? The deletion can be undone for 3 days.'
    });
    const contact = (await runOperation(
      db,
      'contacts.create',
      { displayName: 'Max Muster', phones: [] },
      asRun()
    )) as { id: string };
    await expect(
      runOperation(db, 'contacts.delete', { id: contact.id }, asRun())
    ).rejects.toMatchObject({
      question:
        'Delete the contact Max Muster? The deletion can be undone for 3 days.'
    });
  });

  it('answers 404, not the question, for an unknown id', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(db, 'contacts.delete', { id: 'nothing' }, asRun())
    ).rejects.toMatchObject({ status: 404 });
  });
});
