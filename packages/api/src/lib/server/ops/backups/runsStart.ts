import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { queueRun } from '#lib/server/jobs/cron.js';

import { liveRow } from '../rows.js';
import { afterCommit, setUndoable } from '../runner.js';
import { defineOperation } from '../types.js';
import { runToWire, type BackupRunWire } from './_shared.js';

const inputSchema = z
  .object({
    targetId: z
      .string()
      .describe('The backup target to run, from backups.targets.list.')
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/**
 * `POST /backups/runs` (§6.5 "Backups"): queues a manual run of `targetId`, immediately visible
 * as a `running` row. Once the row has committed, it is handed to the backup scheduler
 * (`jobs/cron.ts` `queueRun`), which updates that same row by id as the run proceeds.
 */
export const runsStart = defineOperation<Input, BackupRunWire>({
  name: 'backups.runs.start',
  description: 'Starts a backup run to one target now, outside the schedule',
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
    const target = await liveRow(
      ctx.db,
      'backupTargets',
      input.targetId,
      'backups: target not found'
    );
    const id = newId();
    await ctx.db
      .insertInto('backupRuns')
      .values({
        id,
        targetId: target.id,
        status: 'running',
        snapshotId: null,
        bytesAdded: null,
        bytesTotal: null,
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
    // After the commit: the scheduler reads the row outside this transaction.
    afterCommit(ctx, () =>
      Promise.resolve(
        queueRun(row)
          ? null
          : 'backups: no backup scheduler runs in this process; the run does not start'
      )
    );
    return runToWire(row);
  }
});
