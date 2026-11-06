import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

const SIX = `language in ('de','en','es','fr','it','ru')`;
const SEVEN = `language in ('de','en','es','fr','it','pl','ru')`;

// settings.language, mail_templates.language — Polish, a seventh tenant language (§9.1, §11.4).
// SQLite cannot change a CHECK, so each table is rebuilt with its rows from its own stored
// definition, the language CHECK alone widened: `settings` has gained columns over many
// migrations, and restating them here would be a second copy to keep in step. Nothing
// references either table, and the migrator runs with foreign keys off.
async function widenLanguageCheck(db: Db, table: string): Promise<void> {
  const { rows } = await sql<{ sql: string }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(
    db
  );
  const definition = rows[0]?.sql ?? '';
  const at = definition.indexOf(SIX);
  if (at === -1 || at !== definition.lastIndexOf(SIX)) {
    throw new Error(`${table}: expected one language CHECK in ${definition}`);
  }
  const next = `${table}_next`;
  await sql
    .raw(
      definition
        .replace(SIX, SEVEN)
        .replace(`CREATE TABLE "${table}"`, `CREATE TABLE "${next}"`)
    )
    .execute(db);
  await sql.raw(`INSERT INTO "${next}" SELECT * FROM "${table}"`).execute(db);
  await db.schema.dropTable(table).execute();
  await db.schema.alterTable(next).renameTo(table).execute();
}

export async function up(db: Db): Promise<void> {
  await widenLanguageCheck(db, 'settings');
  await widenLanguageCheck(db, 'mail_templates');
}
