import type { Db } from '@zamfono/shared';

/**
 * `settings.config_propagation_pending` (§3.1 "Config propagation", §11.4): set while a
 * propagation failed and none has succeeded since, so Asterisk and `core` may run on an older
 * configuration than the database holds.
 */
export async function setPropagationPending(
  db: Db,
  pending: boolean
): Promise<void> {
  await db
    .updateTable('settings')
    .set({ configPropagationPending: pending ? 1 : 0 })
    .where('id', '=', 1)
    .execute();
}

/** Whether `api` owes a propagation. */
export async function isPropagationPending(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('settings')
    .select('configPropagationPending')
    .where('id', '=', 1)
    .executeTakeFirst();
  return row?.configPropagationPending === 1;
}
