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
  await sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, sip_headers_json) VALUES ('ft-sip', 't1', 'proj_a', '[]')`.execute(
    db
  );
  await sql`INSERT INTO user_forward_rules (user_id, condition, target_id) VALUES ('u1', 'busy', 'ft-sip')`.execute(
    db
  );
}

// forward_targets.sip_headers_json (§9.4 "Header templates", §11.2).
test.each([
  [
    'headers on an external target',
    sql`INSERT INTO forward_targets (id, external, sip_headers_json) VALUES ('x1', '+431', '[]')`
  ],
  [
    'a new sip target without headers',
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user) VALUES ('x2', 't1', 'proj_b')`
  ],
  [
    'clearing the headers of a sip target',
    sql`UPDATE forward_targets SET sip_headers_json = NULL WHERE id = 'ft-sip'`
  ],
  [
    'headers on a user target',
    sql`UPDATE forward_targets SET sip_headers_json = '[]' WHERE id = 'ft-user'`
  ],
  [
    'a JSON object',
    sql`UPDATE forward_targets SET sip_headers_json = '{}' WHERE id = 'ft-sip'`
  ],
  [
    'text that is no JSON',
    sql`UPDATE forward_targets SET sip_headers_json = 'nope' WHERE id = 'ft-sip'`
  ]
])('sip headers refuse %s', async (label, statement) => {
  const db = await migratedTestDb();
  await seed(db);
  await expect(statement.execute(db)).rejects.toThrow(
    /CHECK constraint failed/u
  );
});

test('headers on a sip target are a JSON array', async () => {
  const db = await migratedTestDb();
  await seed(db);
  await sql`UPDATE forward_targets SET sip_headers_json = '[]' WHERE id = 'ft-sip'`.execute(
    db
  );
});
