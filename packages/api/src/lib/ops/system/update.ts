import { z } from 'zod';

import { errorMessage } from '../../errors.js';
import { setUndoable } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { updaterClient, UpdaterRefusal, type UpdateState } from './_updater.js';

const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const STATUS_UNAVAILABLE = 503;
/** How recent the backup an update needs must be (§6.3 "Updates"). */
export const BACKUP_MAX_AGE_MS = 3_600_000;

const inputSchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .optional()
      .describe(
        'The release to update to, such as 0.2.0; left out, the latest (see zamfono.help update-stack).'
      )
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** The updater's refusals keep their status where the operations layer has it, else 503. */
function passOn(error: unknown): never {
  if (error instanceof UpdaterRefusal) {
    const status =
      error.status === STATUS_BAD_REQUEST ||
      error.status === STATUS_NOT_FOUND ||
      error.status === STATUS_CONFLICT
        ? error.status
        : STATUS_UNAVAILABLE;
    throw new OpError(status, `system.update: ${error.message}`);
  }
  throw new OpError(
    STATUS_UNAVAILABLE,
    `system.update: the updater did not answer: ${errorMessage(error)}`
  );
}

/**
 * `POST /system/update` (§6.3 "Updates", §10.3): has the updater service take the stack to the
 * latest release, or to `version`, when that release is newer and non-breaking. Refused unless a
 * backup run finished `ok` within the last hour, so the update begins from a restorable point;
 * answers as soon as the updater has begun, and `system.info` reports how it went. Not undoable:
 * migrations only go forward (§6.3 "Upgrades").
 */
export const update = defineOperation<Input, UpdateState>({
  name: 'system.update',
  description:
    'Updates the stack to the latest release, or to version, if newer and non-breaking; needs a backup run finished ok within the last hour. system.info reports the progress.',
  input: inputSchema,
  minRole: 'owner',
  pureAction: true,
  confirm: input =>
    `Update the stack to ${input.version ?? 'the latest release'}? Calls drop while it restarts, and only a restore from the backup undoes it.`,
  entity: () => ({ kind: 'system', id: null }),
  run: async (ctx, input) => {
    setUndoable(ctx, false);
    const client = updaterClient();
    if (client === undefined) {
      throw new OpError(
        STATUS_UNAVAILABLE,
        'system.update: UPDATER_TOKEN is not set in .env; update with update.sh on the host (deploy/README.md, step 8)'
      );
    }
    const since = new Date(
      Date.parse(ctx.now) - BACKUP_MAX_AGE_MS
    ).toISOString();
    const backup = await ctx.db
      .selectFrom('backupRuns')
      .select('id')
      .where('status', '=', 'ok')
      .where('finishedAt', '>=', since)
      .executeTakeFirst();
    if (backup === undefined) {
      throw new OpError(
        STATUS_CONFLICT,
        'system.update: no backup finished ok within the last hour; start one with backups.runs.start, wait until backups.runs.get reports ok, then update'
      );
    }
    return client.update(input.version).catch(passOn);
  }
});
