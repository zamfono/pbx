import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

const TWO = `work in ('certSync','autoUpdate')`;
const THREE = `work in ('certSync','autoUpdate','reboot')`;

// Host control (§6.3 "Host control", §11.2): settings.host_updates (NULL until the host's state
// is first read) and settings.auto_reboot, off for a stack seeded before (the first boot seeds it
// on); update_state's reboot an owner scheduled and since when the host has waited for one; the
// maintenance gate's third work, the reboot. SQLite cannot change a CHECK, so `maintenance_gate`
// is rebuilt from its own stored definition with the CHECK alone widened, as the Polish language
// migration does; nothing references it.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('host_updates', 'integer', col =>
      col.check(sql`host_updates in (0,1)`)
    )
    .execute();
  await db.schema
    .alterTable('settings')
    .addColumn('auto_reboot', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`auto_reboot in (0,1)`)
    )
    .execute();
  await db.schema
    .alterTable('update_state')
    .addColumn('reboot_requested_at', 'text')
    .execute();
  await db.schema
    .alterTable('update_state')
    .addColumn('reboot_requested_by', 'text')
    .execute();
  await db.schema
    .alterTable('update_state')
    .addColumn('reboot_required_since', 'text')
    .execute();
  const { rows } = await sql<{ sql: string }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_gate'`.execute(
    db
  );
  const definition = rows[0]?.sql ?? '';
  const at = definition.indexOf(TWO);
  if (at === -1 || at !== definition.lastIndexOf(TWO)) {
    throw new Error(
      `maintenance_gate: expected one work CHECK in ${definition}`
    );
  }
  await sql
    .raw(
      definition
        .replace(TWO, THREE)
        .replace(
          'CREATE TABLE "maintenance_gate"',
          'CREATE TABLE "maintenance_gate_next"'
        )
    )
    .execute(db);
  await sql
    .raw('INSERT INTO "maintenance_gate_next" SELECT * FROM "maintenance_gate"')
    .execute(db);
  await db.schema.dropTable('maintenance_gate').execute();
  await db.schema
    .alterTable('maintenance_gate_next')
    .renameTo('maintenance_gate')
    .execute();
}
