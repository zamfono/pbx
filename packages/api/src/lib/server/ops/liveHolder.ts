import { sql } from 'kysely';

import type { DB, Db } from '@zamfono/shared';

import { Conflict } from './types.js';

/** A live row holding a value another row wants, as a 409 names it (§5.8). */
export type Collision = { kind: string; id: string; label: string };

/** The soft-deleted tables: only a live row (`deleted_at IS NULL`) holds a unique value (§11.2). */
export type LiveTable = {
  [T in keyof DB]: DB[T] extends { id: string; deletedAt: string | null }
    ? T
    : never;
}[keyof DB];

export type Column<T extends LiveTable> = keyof DB[T] & string;

export type HolderSpec<T extends LiveTable> = {
  table: T;
  kind: string;
  /** The column naming the holder. */
  label: Column<T>;
  /** The values the holder has; `null` matches a NULL column. */
  values: Partial<Record<Column<T>, string | number | null>>;
};

/** The live row of `spec.table` other than `excludeId` holding `spec.values`, if any. */
export async function liveHolder<T extends LiveTable>(
  db: Db,
  { table, kind, label, values }: HolderSpec<T>,
  excludeId?: string
): Promise<Collision | null> {
  // Widened to the union: Kysely resolves no select on a table type that is still generic.
  const from: LiveTable = table;
  let query = db
    .selectFrom(from)
    .select([
      sql.ref<string>('id').as('id'),
      sql.ref<string>(label).as('label')
    ])
    .where(sql.ref('deletedAt'), 'is', null);
  for (const [column, value] of Object.entries(values)) {
    query =
      value === null
        ? query.where(sql.ref(column), 'is', null)
        : query.where(sql.ref(column), '=', value);
  }
  if (excludeId !== undefined) {
    query = query.where(sql.ref('id'), '!=', excludeId);
  }
  const holder = await query.executeTakeFirst();
  return holder ? { kind, id: holder.id, label: holder.label } : null;
}

/** Throws `Conflict(title)` naming the live row that holds `spec.values`, if one does. */
export async function assertNoLiveHolder<T extends LiveTable>(
  db: Db,
  title: string,
  spec: HolderSpec<T>,
  excludeId?: string
): Promise<void> {
  const holder = await liveHolder(db, spec, excludeId);
  if (holder) {
    throw new Conflict(title, [holder]);
  }
}
