import type { Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// webhooks — custom request headers (§10.6 "Request headers", §11.2): `headers_json` holds each
// header's name and, unless it is a secret, its value; the secret ones' values are one encrypted
// JSON object in `secret_headers_enc` (§5.4), keyed by the lower-case name.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('webhooks')
    .addColumn('headers_json', 'text', col => col.notNull().defaultTo('[]'))
    .execute();
  await db.schema
    .alterTable('webhooks')
    .addColumn('secret_headers_enc', 'blob')
    .execute();
}
