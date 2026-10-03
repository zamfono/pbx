import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { type Db } from './db.js';
import { migratedTestDb } from './testDb.js';

async function seed(db: Db): Promise<void> {
  await sql`INSERT INTO users (id, name, email, created_at) VALUES ('u1', 'Anna', 'a@x.test', 't')`.execute(
    db
  );
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, created_at)
            VALUES ('t1', 'T', 1, 1, 'ip', 'tls', 't')`.execute(db);
  await sql`INSERT INTO forward_targets (id, user_id) VALUES ('ft-user', 'u1')`.execute(
    db
  );
  await sql`INSERT INTO forward_targets (id, external) VALUES ('ft-ext', '+4312345')`.execute(
    db
  );
  await sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user) VALUES ('ft-sip', 't1', 'proj_a')`.execute(
    db
  );
  await sql`INSERT INTO user_forward_rules (user_id, condition, target_id) VALUES ('u1', 'busy', 'ft-sip')`.execute(
    db
  );
}

// forward_targets.sip_headers_json (§9.4 "Header templates", §11.2).
test('headers are refused on a row that is no sip target, and must be a JSON array', async () => {
  const db = await migratedTestDb();
  await seed(db);
  const refused = [
    sql`INSERT INTO forward_targets (id, external, sip_headers_json) VALUES ('x1', '+431', '[]')`,
    sql`UPDATE forward_targets SET sip_headers_json = '[]' WHERE id = 'ft-user'`,
    sql`UPDATE forward_targets SET sip_headers_json = '{}' WHERE id = 'ft-sip'`,
    sql`UPDATE forward_targets SET sip_headers_json = 'nope' WHERE id = 'ft-sip'`
  ];
  for (const statement of refused) {
    // eslint-disable-next-line no-await-in-loop -- each statement is refused on its own
    await expect(statement.execute(db)).rejects.toThrow(
      /CHECK constraint failed/u
    );
  }
  await sql`UPDATE forward_targets SET sip_headers_json = '[]' WHERE id = 'ft-sip'`.execute(
    db
  );
});
