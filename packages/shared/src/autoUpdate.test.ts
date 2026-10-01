import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// The auto_update migration (§6.3 "Updates", §11.2): a tenant's mail template overrides survive
// the mail_templates rebuild, the two new kinds are admitted, settings.auto_update starts off,
// and update_state holds its one row from the start.
test('keeps the template overrides, admits the new kinds, starts with auto-update off', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, '1790780978051_trunk_diversion');
  await sql`INSERT INTO mail_templates (kind, language, subject, body_text, body_html, updated_at)
            VALUES ('missedCall', 'de', 'Verpasst', 'Text', NULL, 't')`.execute(
    db
  );
  await expect(
    sql`INSERT INTO mail_templates (kind, language, subject, body_text, updated_at)
        VALUES ('updateFailed', 'de', 's', 'b', 't')`.execute(db)
  ).rejects.toThrow(/CHECK/u);

  await migrateForTest(db);

  await expect(
    db.selectFrom('mailTemplates').select(['kind', 'subject']).execute()
  ).resolves.toEqual([{ kind: 'missedCall', subject: 'Verpasst' }]);
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
