import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// The named §11.4 default: `no-magic-numbers` requires every meaningful literal to carry a name.
const DEFAULT_SMTP_CHECK_INTERVAL_S = 900;

// settings — the seconds between background checks of the mail relay, NULL for none (§10.2
// "Relay check", §11.4).
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('smtp_check_interval_s', 'integer', col =>
      col
        .defaultTo(DEFAULT_SMTP_CHECK_INTERVAL_S)
        .check(sql`smtp_check_interval_s BETWEEN 60 AND 86400`)
    )
    .execute();
}
