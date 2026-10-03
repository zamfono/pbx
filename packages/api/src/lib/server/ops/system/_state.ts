import type { Selectable } from 'kysely';

import { MS_PER_HOUR, type Db, type DB } from '@zamfono/shared';

import { updaterClient } from './_updater.js';

/**
 * `update_state` (§11.2), the one row of what `api` knows about updates beyond the updater's own
 * record (§6.3 "Updates"): when the last run `api` started began, the last automatic attempt's
 * failure with the failed attempts on its release, and the breaking release last seen and
 * announced.
 */
export type UpdateStateRow = Selectable<DB['updateState']>;

/** How many failed automatic attempts on one release end its retries (§6.3 "Automatic updates"). */
export const MAX_AUTO_UPDATE_ATTEMPTS = 3;

const RETRY_GAP_HOURS = 20;
/**
 * How long after a failed automatic attempt the release waits before the next, so it is retried
 * at about one maintenance moment a day even where every moment is one (§6.3 "Automatic updates").
 */
export const AUTO_UPDATE_RETRY_GAP_MS = RETRY_GAP_HOURS * MS_PER_HOUR;

/**
 * Why the last automatic update failed, on which release and when, and how many attempts on that
 * release failed; `null` while none failed.
 */
export type AutoUpdateFailure = {
  version: string;
  reason: string;
  at: string;
  attempts: number;
};

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
  return { version, reason, at, attempts: row.autoFailedAttempts };
}

/**
 * Whether the automatic update holds off `version` at `now`: for good once its failed attempts
 * reached `MAX_AUTO_UPDATE_ATTEMPTS`, else until `AUTO_UPDATE_RETRY_GAP_MS` after the last.
 */
export function retryHeldOff(
  row: UpdateStateRow | undefined,
  version: string,
  now: Date
): boolean {
  const failure = autoUpdateFailure(row);
  if (failure?.version !== version) {
    return false;
  }
  return (
    failure.attempts >= MAX_AUTO_UPDATE_ATTEMPTS ||
    now.getTime() < Date.parse(failure.at) + AUTO_UPDATE_RETRY_GAP_MS
  );
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
      autoFailedAt: failure?.at ?? null,
      autoFailedAttempts: failure?.attempts ?? 0
    })
    .where('id', '=', 1)
    .execute();
}

/**
 * What `update_state` tells `/healthz` and `/metrics` (§6.3 "Automatic updates", §7): whether an
 * automatic update failed, with the failed attempts on its release, and whether a breaking
 * release waits for `update.sh`.
 */
export type UpdateNews = {
  autoUpdateFailed: boolean;
  autoUpdateFailedAttempts: number;
  breakingUpdateAvailable: boolean;
};

const NO_UPDATE_NEWS: UpdateNews = {
  autoUpdateFailed: false,
  autoUpdateFailedAttempts: 0,
  breakingUpdateAvailable: false
};

/**
 * `UpdateNews` from `update_state`; none while `.env` sets no `UPDATER_TOKEN`: without an
 * updater there are no automatic updates and no report of a breaking release. The record is
 * kept, should the token come back.
 */
export async function updateNews(db: Db): Promise<UpdateNews> {
  if (updaterClient() === undefined) {
    return NO_UPDATE_NEWS;
  }
  const row = await loadUpdateState(db);
  const failure = autoUpdateFailure(row);
  return {
    autoUpdateFailed: failure !== null,
    autoUpdateFailedAttempts: failure?.attempts ?? 0,
    breakingUpdateAvailable: (row?.breakingVersion ?? null) !== null
  };
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
