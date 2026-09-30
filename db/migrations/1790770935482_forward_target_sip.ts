import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// forward_targets.sip_trunk_id and sip_user (§9.4 "SIP targets", §11.2): a target that dials a
// request-URI user part over a trunk. SQLite's `ADD COLUMN` could add the two columns, but not
// widen the table's exactly-one CHECK to the eighth kind, since no `ALTER TABLE` changes a table
// constraint; the table is rebuilt the way SQLite documents and `trunk_emergency` did: a new
// table, the rows copied with their ids, the old one dropped, the new one renamed. The nine
// owner columns of other tables that reference `forward_targets` name it, so they point at the
// new table once it is renamed. `down` rebuilds it the other way, refused while a `sip` target
// exists, which the old table cannot hold.

/** The exactly-one CHECK over the target columns, with or without the `sip` pair (§11.2). */
function oneKindCheck(withSip: boolean): ReturnType<typeof sql> {
  return withSip
    ? sql`(user_id is not null) + (ring_group_id is not null) + (external is not null) +
             (sip_trunk_id is not null) + (mailbox_user_id is not null) +
             (mailbox_ring_group_id is not null) + (announcement_audio_id is not null) +
             (menu_id is not null) = 1`
    : sql`(user_id is not null) + (ring_group_id is not null) + (external is not null) +
             (mailbox_user_id is not null) + (mailbox_ring_group_id is not null) +
             (announcement_audio_id is not null) + (menu_id is not null) = 1`;
}

/** `forward_targets_new` as the initial migration creates `forward_targets`, plus, `withSip`,
 * the `sip` pair after `external`. */
async function createForwardTargetsNew(
  db: Db,
  withSip: boolean
): Promise<void> {
  let table = db.schema
    .createTable('forward_targets_new')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.references('users.id').onDelete('restrict')
    )
    .addColumn('ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('restrict')
    )
    .addColumn('external', 'text', col =>
      col.check(
        sql`external is null or (external glob '+[0-9]*' and substr(external, 2) not glob '*[^0-9]*')`
      )
    );
  if (withSip) {
    table = table
      .addColumn('sip_trunk_id', 'text', col =>
        col.references('trunks.id').onDelete('restrict')
      )
      // RFC 3261's unreserved `.`, `_`, `~`, `-` and the user-unreserved `+`: a user part that
      // needs no escaping and cannot reach into the dial string (§9.4 "SIP targets").
      .addColumn('sip_user', 'text', col =>
        col.check(
          sql`sip_user is null or (length(sip_user) between 1 and 64 and sip_user not glob '*[^A-Za-z0-9._~+-]*')`
        )
      )
      .addCheckConstraint(
        'forward_targets_sip_pair',
        sql`(sip_trunk_id is null) = (sip_user is null)`
      );
  }
  await table
    .addColumn('mailbox_user_id', 'text', col =>
      col.references('users.id').onDelete('restrict')
    )
    .addColumn('mailbox_ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('restrict')
    )
    .addColumn('announcement_audio_id', 'text', col =>
      col.references('audio_assets.id').onDelete('restrict')
    )
    .addColumn('menu_id', 'text', col =>
      col.references('menus.id').onDelete('restrict')
    )
    .addCheckConstraint('forward_targets_one_kind', oneKindCheck(withSip))
    .execute();
}

/** The columns both tables share, copied as they are. */
const COPIED_COLUMNS = [
  'id',
  'user_id',
  'ring_group_id',
  'external',
  'mailbox_user_id',
  'mailbox_ring_group_id',
  'announcement_audio_id',
  'menu_id'
] as const;

async function rebuildForwardTargets(trx: Db, withSip: boolean): Promise<void> {
  await createForwardTargetsNew(trx, withSip);
  const columns = sql.join(COPIED_COLUMNS.map(column => sql.ref(column)));
  await sql`INSERT INTO forward_targets_new (${columns}) SELECT ${columns} FROM forward_targets`.execute(
    trx
  );
  await trx.schema.dropTable('forward_targets').execute();
  await trx.schema
    .alterTable('forward_targets_new')
    .renameTo('forward_targets')
    .execute();
  // Every owner column that references `forward_targets` points at the new table once it is
  // renamed; this confirms no row lost its target on the way.
  const { rows } = await sql`PRAGMA foreign_key_check`.execute(trx);
  if (rows.length > 0) {
    throw new Error('forward_targets rebuild left dangling foreign keys');
  }
}

/** Rebuilds with foreign keys off: dropping `forward_targets` while they are enforced would be
 * refused by its owner columns' `RESTRICT`. The pragma is a no-op inside a transaction, so it is
 * switched here, on the migrator's connection, which Kysely does not wrap in one for SQLite. */
async function rebuild(db: Db, withSip: boolean): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await rebuildForwardTargets(trx, withSip);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function up(db: Db): Promise<void> {
  await rebuild(db, true);
}

export async function down(db: Db): Promise<void> {
  const { rows } =
    await sql`SELECT id FROM forward_targets WHERE sip_trunk_id IS NOT NULL LIMIT 1`.execute(
      db
    );
  if (rows.length > 0) {
    throw new Error(
      'forward_targets holds a sip target, which the old table cannot hold'
    );
  }
  await rebuild(db, false);
}
