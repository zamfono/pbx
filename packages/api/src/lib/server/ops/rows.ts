import type { Selectable } from 'kysely';

import { HTTP_NOT_FOUND, type DB, type Db } from '@zamfono/shared';

import { recordChange } from './audit.js';
import type { LiveTable } from './liveHolder.js';
import { OpError, type Context } from './types.js';

/** The live row of `table` with `id`, or `OpError(404, notFoundMessage)`. */
export async function liveRow<T extends LiveTable>(
  db: Db,
  table: T,
  id: string,
  notFoundMessage: string
): Promise<Selectable<DB[T]>> {
  // Widened to the union: Kysely resolves no select on a table type that is still generic.
  const from: LiveTable = table;
  const row = await db
    .selectFrom(from)
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(HTTP_NOT_FOUND, notFoundMessage);
  }
  return row as Selectable<DB[T]>;
}

/** Soft-deletes the row of `table` with `id` and records the `deletedAt` change (§11.2). */
export async function softDelete(
  ctx: Context,
  table: LiveTable,
  id: string
): Promise<void> {
  await ctx.db
    .updateTable(table)
    .set({ deletedAt: ctx.now })
    .where('id', '=', id)
    .execute();
  recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
}
