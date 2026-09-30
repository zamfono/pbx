import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// forward_targets.sip_headers_json (§9.4 "Header templates", §11.2): a sip target's custom
// headers, a JSON array of { name, value }. SQLite's `ADD COLUMN` takes a CHECK naming another
// column, and tests it against every existing row; it cannot require the column on a sip row,
// which every existing sip row would fail before the update below fills it, so the API sets it
// on every sip row instead. The existing sip targets get the headers a new one gets when written
// without any: the original caller and the DID, as the fixed headers they sent before. The
// migrator's connection is not wrapped in a transaction for SQLite, so one is opened here: a
// failed update leaves no column behind for the retry to trip over.

const DEFAULT_HEADERS = JSON.stringify([
  { name: 'X-Zamfono-Caller', value: '{{callerNumber}}' },
  { name: 'X-Zamfono-Did', value: '{{did}}' }
]);

async function addColumn(trx: Db): Promise<void> {
  await trx.schema
    .alterTable('forward_targets')
    .addColumn('sip_headers_json', 'text', col =>
      col.check(
        sql`sip_headers_json is null or (sip_trunk_id is not null and json_valid(sip_headers_json) and json_type(sip_headers_json) = 'array')`
      )
    )
    .execute();
  await sql`UPDATE forward_targets SET sip_headers_json = ${DEFAULT_HEADERS} WHERE sip_trunk_id IS NOT NULL`.execute(
    trx
  );
}

export async function up(db: Db): Promise<void> {
  await db.transaction().execute(addColumn);
}

export async function down(db: Db): Promise<void> {
  await db.schema
    .alterTable('forward_targets')
    .dropColumn('sip_headers_json')
    .execute();
}
