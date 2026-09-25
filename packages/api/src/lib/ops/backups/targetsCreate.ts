import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '../../secretbox.js';
import { recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  paramsSchema,
  targetKindSchema,
  targetToWire,
  withDefaultForgetPolicy,
  type BackupTargetWire
} from './_shared.js';

const inputSchema = z
  .object({
    kind: targetKindSchema,
    params: paramsSchema,
    secret: z.string().min(1),
    enabled: z.boolean().optional()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** `POST /backups/targets` (§6.5 "Backups"): a restic destination for the nightly backup job. */
export const targetsCreate = defineOperation<Input, BackupTargetWire>({
  name: 'backups.targets.create',
  description: 'Adds a backup target',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, output: BackupTargetWire) => ({
    kind: 'backupTarget',
    id: output.id
  }),
  run: async (ctx, input) => {
    const id = newId();
    const enabled = input.enabled ?? true;
    const params = withDefaultForgetPolicy(input.params);
    const secretEnc = encrypt(keyringFromEnv(process.env), input.secret);
    await ctx.db
      .insertInto('backupTargets')
      .values({
        id,
        kind: input.kind,
        paramsJson: JSON.stringify(params),
        enabled: enabled ? 1 : 0,
        secretEnc,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'kind', from: null, to: input.kind });
    recordChange(ctx, { field: 'secret', from: null, to: input.secret });
    const row = await ctx.db
      .selectFrom('backupTargets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return targetToWire(row);
  }
});
