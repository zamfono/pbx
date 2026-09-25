import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { runToWire } from './_shared.js';

const STATUS_NOT_FOUND = 404;

const inputSchema = z.object({ id: z.string() }).strict();

/** `GET /backups/runs/{id}` (§6.5 "Backups"): one run's status and result. */
export const runsGet = defineOperation({
  name: 'backups.runs.get',
  description: 'Reads one backup run',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom('backupRuns')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, 'backups: run not found');
    }
    return runToWire(row);
  }
});
