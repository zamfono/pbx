import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// settings.prompt_voice — the voice of the tenant's prompts, one of the two each generated set has
// (§9.1, §11.4).
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('prompt_voice', 'text', col =>
      col
        .notNull()
        .defaultTo('female')
        .check(sql`prompt_voice in ('female','male')`)
    )
    .execute();
}
