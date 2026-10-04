import { sql } from 'kysely';

import type { DB, Db } from '@zamfono/shared';

import { Conflict, type Context } from '../types.js';
import { ENTITY_TABLES } from './_shared.js';

/** One foreign key of the schema: `child.column` references `parent`, with its delete action. */
type ForeignKey = {
  child: string;
  column: string;
  parent: string;
  onDelete: string;
};

type Row = Record<string, unknown>;
type Holder = { table: string; row: Row };
type Reference = { kind: string; id: string; label: string };

const FORWARD_TARGETS = 'forward_targets';

// Columns recording who created a row: no routing reads them, and a purge clearing them on a
// live row loses nothing (§11.2).
const PROVENANCE_COLUMNS = new Set([
  'audio_assets.uploaded_by',
  'blocked_numbers.created_by'
]);

/** `snake_case` as the camel-cased key a raw row carries it under (`CamelCasePlugin`). */
function camel(name: string): string {
  return name.replace(/_(?<letter>[a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase()
  );
}

/** A `camelCase` table name as SQLite holds it. */
function snake(name: string): string {
  return name.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`);
}

/** Every foreign key of the schema, read from SQLite itself. */
async function foreignKeys(db: Db): Promise<ForeignKey[]> {
  const { rows } = await sql<ForeignKey>`
    select m.name as child, f."from" as "column", f."table" as parent,
      f.on_delete as on_delete
    from sqlite_master m join pragma_foreign_key_list(m.name) f
    where m.type = 'table'`.execute(db);
  return rows;
}

/** The tables that carry `deleted_at` (§5.9). */
async function softDeleteTables(db: Db): Promise<Set<string>> {
  const { rows } = await sql<{ name: string }>`
    select m.name from sqlite_master m join pragma_table_info(m.name) c
    where m.type = 'table' and c.name = 'deleted_at'`.execute(db);
  return new Set(rows.map(row => row.name));
}

async function rowsWhere(
  db: Db,
  table: string,
  column: string,
  value: unknown
): Promise<Row[]> {
  const { rows } = await sql<Row>`select * from ${sql.table(table)}
    where ${sql.ref(column)} = ${value}`.execute(db);
  return rows;
}

/**
 * The revived row and the forward targets it routes to (§11.2): its own, and those of the live
 * rows it owns, which go with it on delete (its rules, menu options, OOO rules and schedules).
 */
async function holders(
  db: Db,
  keys: ForeignKey[],
  revived: Holder
): Promise<Holder[]> {
  const owned = await Promise.all(
    keys
      .filter(
        key =>
          key.parent === revived.table &&
          key.child !== FORWARD_TARGETS &&
          key.onDelete === 'CASCADE'
      )
      .map(async key =>
        (await rowsWhere(db, key.child, key.column, revived.row.id))
          .filter(row => row.deletedAt === undefined || row.deletedAt === null)
          .map(row => ({ table: key.child, row }))
      )
  );
  const routing = [revived, ...owned.flat()];
  const targets = await Promise.all(
    routing.flatMap(holder =>
      keys
        .filter(
          key => key.child === holder.table && key.parent === FORWARD_TARGETS
        )
        .map(key => holder.row[camel(key.column)])
        .filter(id => id !== null && id !== undefined)
        .map(async id => rowsWhere(db, FORWARD_TARGETS, 'id', id))
    )
  );
  return [
    revived,
    ...targets.flat().map(row => ({ table: FORWARD_TARGETS, row }))
  ];
}

/** The entity kind a soft-delete table's rows are named by (§5.8), else the table itself. */
function kindOf(table: string): string {
  const entry = Object.entries(ENTITY_TABLES).find(
    ([, name]) => name === camel(table)
  );
  return entry?.[0] ?? table;
}

/**
 * Refuses an undo whose revived row would point at a row deleted meanwhile (§5.8): the revived
 * row's own references, and those of the forward targets it routes to, each a foreign key into a
 * soft-delete table; the conflict names each deleted row, to be revived first. Mirrors the delete
 * refusal (§5.9), so no live row references a row the purge removes.
 */
export async function refuseDeletedReferences(
  ctx: Context,
  entityTable: keyof DB,
  id: string
): Promise<void> {
  const table = snake(entityTable);
  const [keys, softDelete, [row]] = await Promise.all([
    foreignKeys(ctx.db),
    softDeleteTables(ctx.db),
    rowsWhere(ctx.db, table, 'id', id)
  ]);
  if (!row) {
    return;
  }
  const checked = await holders(ctx.db, keys, { table, row });
  const found = await Promise.all(
    checked.flatMap(holder =>
      keys
        .filter(
          key =>
            key.child === holder.table &&
            softDelete.has(key.parent) &&
            !PROVENANCE_COLUMNS.has(`${key.child}.${key.column}`)
        )
        .map(key => ({
          parent: key.parent,
          value: holder.row[camel(key.column)]
        }))
        .filter(ref => ref.value !== null && ref.value !== undefined)
        .map(async ({ parent, value }) => {
          const [target] = await rowsWhere(ctx.db, parent, 'id', value);
          if (!target || target.deletedAt === null) {
            return null;
          }
          return {
            kind: kindOf(parent),
            id: String(target.id),
            label: String(
              target.name ?? target.label ?? target.number ?? target.id
            )
          };
        })
    )
  );
  const references = [
    ...new Map(
      found
        .filter((ref): ref is Reference => ref !== null)
        .map(ref => [`${ref.kind}:${ref.id}`, ref])
    ).values()
  ];
  if (references.length > 0) {
    throw new Conflict(
      `undo the deletion of ${references.map(ref => `${ref.kind} ${ref.label}`).join(', ')} first`,
      references
    );
  }
}
