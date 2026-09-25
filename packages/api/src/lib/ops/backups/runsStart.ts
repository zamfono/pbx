import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { setUndoable } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { loadLiveTarget, runToWire, type BackupRunWire } from './_shared.js';

const STATUS_NOT_FOUND = 404;

const inputSchema = z.object({ targetId: z.string() }).strict();

type Input = z.infer<typeof inputSchema>;

/**
 * `POST /backups/runs` (§6.5 "Backups"): queues a manual run of `targetId`, immediately visible
 * as a `running` row. The backup scheduler (`jobs/cron.ts`) finds it by polling `backup_runs` for
 * `running` rows, since it and the operations layer are separate bundles with separate module
 * state, and updates that same row by id as the run proceeds.
 */
export const runsStart = defineOperation<Input, BackupRunWire>({
  name: 'backups.runs.start',
  description: 'Starts a backup run',
  input: inputSchema,
  minRole: 'admin',
  pureAction: true,
  entity: (_input, output: BackupRunWire) => ({
    kind: 'backupRun',
    id: output.id
  }),
  run: async (ctx, input) => {
    // A manual run is a pure action on no prior state: nothing to revert (§5.8).
    setUndoable(ctx, false);
    const target = await loadLiveTarget(ctx.db, input.targetId);
    if (!target) {
      throw new OpError(STATUS_NOT_FOUND, 'backups: target not found');
    }
    const id = newId();
    await ctx.db
      .insertInto('backupRuns')
      .values({
        id,
        targetId: target.id,
        status: 'running',
        snapshotId: null,
        bytes: null,
        error: null,
        startedAt: ctx.now,
        finishedAt: null
      })
      .execute();
    const row = await ctx.db
      .selectFrom('backupRuns')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return runToWire(row);
  }
});
