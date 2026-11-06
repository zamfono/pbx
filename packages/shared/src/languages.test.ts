import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { LANGUAGES } from './columnValues.js';
import { migratedTestDb, seedSettings } from './testDb.js';

// The schema's language CHECKs accept exactly the tenant languages (§11.2, §11.4).
test('settings.language and mail_templates.language take every tenant language, and no other', async () => {
  const db = await migratedTestDb();
  await seedSettings(db);
  for (const language of LANGUAGES) {
    // eslint-disable-next-line no-await-in-loop -- one language after another on the one row
    await sql`UPDATE settings SET language = ${language}`.execute(db);
    // eslint-disable-next-line no-await-in-loop -- one language after another on the one row
    await sql`INSERT INTO mail_templates (kind, language, subject, body_text, updated_at)
              VALUES ('reset', ${language}, 's', 'b', 't')`.execute(db);
  }
  await expect(
    sql`UPDATE settings SET language = 'xx'`.execute(db)
  ).rejects.toThrow(/CHECK/u);
  await expect(
    sql`INSERT INTO mail_templates (kind, language, subject, body_text, updated_at)
        VALUES ('reset', 'xx', 's', 'b', 't')`.execute(db)
  ).rejects.toThrow(/CHECK/u);
});
