import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// Automatic updates (§6.3 "Updates", §11.2): mail_templates admits the two update mails, and
// update_state holds its one row from the start.
test('admits the update mail kinds and starts update_state with its one row', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await sql`INSERT INTO mail_templates (kind, language, subject, body_text, updated_at)
            VALUES ('updateFailed', 'de', 's', 'b', 't'),
                   ('breakingUpdate', 'de', 's', 'b', 't')`.execute(db);
  await expect(
    db.selectFrom('updateState').selectAll().execute()
  ).resolves.toEqual([
    {
      id: 1,
      runTrigger: null,
      runActorName: null,
      runStartedAt: null,
      runOutcomePending: 0,
      autoFailedVersion: null,
      autoFailure: null,
      autoFailedAt: null,
      autoFailedAttempts: 0,
      breakingVersion: null,
      breakingAnnounced: null
    }
  ]);
  // A failure is recorded whole: version, reason, time and at least one attempt together.
  await expect(
    db.updateTable('updateState').set({ autoFailure: 'x' }).execute()
  ).rejects.toThrow(/CHECK/u);
  await expect(
    db
      .updateTable('updateState')
      .set({ autoFailedVersion: 'v', autoFailure: 'x', autoFailedAt: 't' })
      .execute()
  ).rejects.toThrow(/CHECK/u);
  await expect(
    db.updateTable('updateState').set({ autoFailedAttempts: 1 }).execute()
  ).rejects.toThrow(/CHECK/u);
  await db
    .updateTable('updateState')
    .set({
      autoFailedVersion: 'v',
      autoFailure: 'x',
      autoFailedAt: 't',
      autoFailedAttempts: 1
    })
    .execute();
  await expect(
    db.insertInto('updateState').values({ id: 2 }).execute()
  ).rejects.toThrow(/CHECK/u);
});
