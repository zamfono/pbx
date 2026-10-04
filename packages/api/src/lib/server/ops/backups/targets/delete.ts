import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import {
  idOutput,
  liveRow,
  softDelete,
  softDeleteQuestion
} from '#lib/server/ops/rows.js';
import { defineOperation } from '#lib/server/ops/types.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /backups/targets/{id}` (§6.5 "Backups", §5.9): soft-deletes a backup target. */
export const targetsDelete = defineOperation({
  name: 'backups.targets.delete',
  description: 'Soft-deletes a backup target; no further run backs up to it',
  input: inputSchema,
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) => {
    const target = await liveRow(
      ctx.db,
      'backupTargets',
      input.id,
      'backups: target not found'
    );
    return softDeleteQuestion(ctx, `the ${target.kind} backup target`);
  },
  entity: input => ({ kind: 'backupTarget', id: input.id }),
  run: async (ctx, input) => {
    await liveRow(
      ctx.db,
      'backupTargets',
      input.id,
      'backups: target not found'
    );
    await softDelete(ctx, 'backupTargets', input.id);
    return { id: input.id };
  }
});
