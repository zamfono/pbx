import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE,
  MS_PER_HOUR,
  type Db,
  type RunRequester,
  type UpdateState
} from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';

import { OpError } from '../types.js';
import { updaterClient, UpdaterRefusal } from './_updater.js';

/** How recent the backup an update needs must be (§6.3 "Updates"). */
export const BACKUP_MAX_AGE_MS = MS_PER_HOUR;

/** The updater's refusals keep their status where the operations layer has it, else 503. */
function passOn(error: unknown): never {
  if (error instanceof UpdaterRefusal) {
    const status =
      error.status === HTTP_BAD_REQUEST ||
      error.status === HTTP_NOT_FOUND ||
      error.status === HTTP_CONFLICT
        ? error.status
        : HTTP_SERVICE_UNAVAILABLE;
    throw new OpError(status, `system.update: ${error.message}`);
  }
  throw new OpError(
    HTTP_SERVICE_UNAVAILABLE,
    `system.update: the updater did not answer: ${errorMessage(error)}`
  );
}

/**
 * Hands an update to the updater (§6.3 "Updates"), the one path `system.update` and the
 * automatic update (`jobs/autoUpdate.ts`) share: the latest release, or `version`. Refused
 * unless `.env` sets `UPDATER_TOKEN` and a backup run finished `ok` within the last hour, so the
 * update begins from a restorable point. The updater records who asked with the run; so does
 * `update_state` once the updater has begun, for an updater that keeps no such record, and so the
 * automatic update can follow its own run up.
 */
export async function requestUpdate(
  db: Db,
  now: string,
  version: string | undefined,
  requester: RunRequester
): Promise<UpdateState> {
  const client = updaterClient();
  if (client === undefined) {
    throw new OpError(
      HTTP_SERVICE_UNAVAILABLE,
      'system.update: UPDATER_TOKEN is not set in .env; update with update.sh on the host (deploy/README.md, step 8)'
    );
  }
  const since = new Date(Date.parse(now) - BACKUP_MAX_AGE_MS).toISOString();
  const backup = await db
    .selectFrom('backupRuns')
    .select('id')
    .where('status', '=', 'ok')
    .where('finishedAt', '>=', since)
    .executeTakeFirst();
  if (backup === undefined) {
    throw new OpError(
      HTTP_CONFLICT,
      'system.update: no backup finished ok within the last hour; start one with backups.runs.start, wait until backups.runs.get reports ok, then update'
    );
  }
  const state = await client.update(version, requester).catch(passOn);
  await db
    .updateTable('updateState')
    .set({
      runTrigger: requester.trigger,
      runActorName: requester.by,
      runStartedAt: state.startedAt ?? now,
      runOutcomePending: requester.trigger === 'automatic' ? 1 : 0
    })
    .where('id', '=', 1)
    .execute();
  return state;
}
