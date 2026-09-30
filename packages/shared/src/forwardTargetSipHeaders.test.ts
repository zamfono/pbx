import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb, type Db } from './db.js';
import { DEFAULT_SIP_HEADERS } from './sipHeaders.js';
import { migrateForTest } from './testDb.js';

const BEFORE = '1790770935482_forward_target_sip';

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

// The forward_target_sip_headers migration (§9.4 "Header templates", §11.2) on a database that
// holds a sip target and two others: the sip row gets the default headers, the fixed ones it sent
// before, and every other row none.
test('an existing sip target gets the default headers, every other row none', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, BEFORE);
  await seed(db);

  await migrateForTest(db);

  const { rows } = await sql<{
    id: string;
    sipHeadersJson: string | null;
  }>`SELECT id, sip_headers_json FROM forward_targets ORDER BY id`.execute(db);
  expect(
    rows.map(row => ({
      id: row.id,
      headers:
        row.sipHeadersJson === null
          ? null
          : (JSON.parse(row.sipHeadersJson) as unknown)
    }))
  ).toEqual([
    { id: 'ft-ext', headers: null },
    { id: 'ft-sip', headers: DEFAULT_SIP_HEADERS },
    { id: 'ft-user', headers: null }
  ]);
  const { rows: dangling } = await sql`PRAGMA foreign_key_check`.execute(db);
  expect(dangling).toEqual([]);
});

test('headers are refused on a row that is no sip target, and must be a JSON array', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
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

test('down drops the column again', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await migrateForTest(db, BEFORE);
  const { rows } = await sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('forward_targets')`.execute(db);
  expect(rows.map(row => row.name)).not.toContain('sip_headers_json');
});
