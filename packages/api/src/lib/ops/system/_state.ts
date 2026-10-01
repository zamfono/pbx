import type { Selectable } from 'kysely';

import type { Db, DB } from '@zamfono/shared';

import type { UpdaterStatus, UpdateState } from './_updater.js';

/**
 * `update_state` (§11.2), the one row of what `api` knows about updates beyond the updater's own
 * record (§6.3 "Updates"): who asked for the last run `api` started, the last automatic attempt's
 * failure, and the breaking release last seen and announced.
 */
export type UpdateStateRow = Selectable<DB['updateState']>;

/** Why the last automatic update failed, and on which release; `null` while none failed. */
export type AutoUpdateFailure = { version: string; reason: string; at: string };

/** The row, or `undefined` for a database without the table or its row yet. */
export async function loadUpdateState(
  db: Db
): Promise<UpdateStateRow | undefined> {
  return db
    .selectFrom('updateState')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirst();
}

export function autoUpdateFailure(
  row: UpdateStateRow | undefined
): AutoUpdateFailure | null {
  if (row === undefined) {
    return null;
  }
  const { autoFailedVersion: version, autoFailure: reason } = row;
  const at = row.autoFailedAt;
  if (version === null || reason === null || at === null) {
    return null;
  }
  return { version, reason, at };
}

/** Records `failure` as the last automatic attempt's, or clears it with `null`. */
export async function setAutoUpdateFailure(
  db: Db,
  failure: AutoUpdateFailure | null
): Promise<void> {
  await db
    .updateTable('updateState')
    .set({
      autoFailedVersion: failure?.version ?? null,
      autoFailure: failure?.reason ?? null,
      autoFailedAt: failure?.at ?? null
    })
    .where('id', '=', 1)
    .execute();
}

/** `settings.auto_update` (§11.4); off for a database without its settings row yet. */
export async function autoUpdateEnabled(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('settings')
    .select('autoUpdate')
    .where('id', '=', 1)
    .executeTakeFirst();
  return row?.autoUpdate === 1;
}

/**
 * The updater's last run with who asked for it (§6.3 "Updates"), as the record says, else as
 * `update_state` says for the run `api` started, since an updater the automatic update brought no
 * newer keeps no `trigger`. A run neither names stays without one.
 */
export function attributeLast(
  last: UpdateState,
  row: UpdateStateRow | undefined
): UpdateState {
  if (row === undefined || last.trigger !== undefined) {
    return last;
  }
  const { runTrigger: trigger, runActorName: by } = row;
  if (trigger === null || row.runStartedAt !== last.startedAt) {
    return last;
  }
  return {
    ...last,
    trigger: trigger as 'manual' | 'automatic',
    ...(by === null ? {} : { by })
  };
}

/** `status` with its `last` run attributed. */
export function attributeStatus(
  status: UpdaterStatus,
  row: UpdateStateRow | undefined
): UpdaterStatus {
  return { ...status, last: attributeLast(status.last, row) };
}
