import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

const DEFAULT_FEATURE_CODES_JSON =
  '{"pickup":"*8","dndOn":"*90","dndOff":"*91","dndToggle":"*92","mailbox":"*95","ownVoicemail":"*96","deposit":"*97","addParty":"*5","clirOn":"#31#","clirOff":"*31#","park":"*70"}';

// The code a stack gets for `dndToggle`: the first of these that neither prefixes one of its
// codes nor is prefixed by one (§9.3), so a stack that remapped its codes keeps a valid set.
const CANDIDATES = ['*92', '*93', '*94', '*98', '*99', '#92', '#93', '#94'];

/** The first candidate free of every code in `codes`. */
function freeCode(codes: string[]): string {
  const free = CANDIDATES.find(candidate =>
    codes.every(
      code => !code.startsWith(candidate) && !candidate.startsWith(code)
    )
  );
  if (free === undefined) {
    throw new Error('settings: no free feature code for dndToggle');
  }
  return free;
}

// settings.feature_codes_json — an eleventh key, `dndToggle` (§9.3): it toggles the caller's DND,
// and `<code><own ext>` is also the user's DND hint a desk phone's DND key watches. SQLite cannot
// change a column's default, so the column is replaced by one with the new default, its values
// copied with the key added.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('feature_codes_json_next', 'text', col =>
      col.notNull().defaultTo(DEFAULT_FEATURE_CODES_JSON)
    )
    .execute();
  const rows = await sql<{ id: number; json: string }>`
    SELECT id, feature_codes_json AS json FROM settings`.execute(db);
  for (const row of rows.rows) {
    const codes = JSON.parse(row.json) as Record<string, string>;
    const next = { ...codes, dndToggle: freeCode(Object.values(codes)) };
    // eslint-disable-next-line no-await-in-loop -- one settings row
    await sql`UPDATE settings SET feature_codes_json_next = ${JSON.stringify(next)} WHERE id = ${row.id}`.execute(
      db
    );
  }
  await db.schema
    .alterTable('settings')
    .dropColumn('feature_codes_json')
    .execute();
  await db.schema
    .alterTable('settings')
    .renameColumn('feature_codes_json_next', 'feature_codes_json')
    .execute();
}
