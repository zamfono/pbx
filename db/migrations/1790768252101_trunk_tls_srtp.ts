import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// trunks.srtp and trunks.tls_verify (§9.4 "Signaling", §11.2). SQLite's `ADD COLUMN` takes a NOT
// NULL column with a default and a CHECK, which it tests against every existing row, so no
// rebuild is needed. `srtp` starts at 0 everywhere: no trunk encrypted its media before. Its CHECK
// names `transport` too, which SQLite allows in a column constraint. `tls_verify` is added at 1,
// the value a new trunk gets, which a non-TLS trunk keeps for the day it is switched to TLS; the
// existing TLS trunks are then set to 0, since `transport-tls` verified no certificate before this
// migration, so their connections behave exactly as they did. The migrator's connection is not
// wrapped in a transaction for SQLite, so one is opened here: a failed update leaves neither
// column behind for the retry to trip over.

async function addColumns(trx: Db): Promise<void> {
  await trx.schema
    .alterTable('trunks')
    .addColumn('srtp', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`srtp in (0,1) and (srtp = 0 or transport = 'tls')`)
    )
    .execute();
  await trx.schema
    .alterTable('trunks')
    .addColumn('tls_verify', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`tls_verify in (0,1)`)
    )
    .execute();
  await sql`UPDATE trunks SET tls_verify = 0 WHERE transport = 'tls'`.execute(
    trx
  );
}

export async function up(db: Db): Promise<void> {
  await db.transaction().execute(addColumns);
}

export async function down(db: Db): Promise<void> {
  await db.schema.alterTable('trunks').dropColumn('tls_verify').execute();
  await db.schema.alterTable('trunks').dropColumn('srtp').execute();
}
