import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// trunks — what a forwarded or blind-transferred leg over the trunk presents: its own number, or
// the original caller's with the own number in `P-Asserted-Identity` or `P-Preferred-Identity`,
// only on a `from` trunk that sends `Diversion`, by which the carrier recognises the forwarding
// (§9.4 "Forwarded calls", §11.2).
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('trunks')
    .addColumn('forwarded_caller_id', 'text', col =>
      col
        .notNull()
        .defaultTo('own')
        .check(
          sql`forwarded_caller_id in ('own','original','originalPreferred')`
        )
    )
    .execute();
  await db.schema
    .alterTable('trunks')
    .addCheckConstraint(
      'trunks_forwarded_caller_id_layout',
      sql`forwarded_caller_id = 'own' or (caller_id_header = 'from' and diversion in ('last','all'))`
    )
    .execute();
}
