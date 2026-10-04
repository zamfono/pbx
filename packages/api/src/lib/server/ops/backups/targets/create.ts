import * as env from '$app/env/private';
import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { recordChange } from '#lib/server/ops/audit.js';
import { defineOperation } from '#lib/server/ops/types.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { assertSecretFitsKind, sealTargetSecret } from '../_secret.js';
import {
  targetFields,
  targetToWire,
  withDefaultForgetPolicy,
  type BackupTargetWire
} from '../_shared.js';

const inputSchema = z.object(targetFields).strict();

type Input = z.infer<typeof inputSchema>;

/** `POST /backups/targets` (§6.5 "Backups"): a restic destination for the nightly backup job. */
export const targetsCreate = defineOperation<Input, BackupTargetWire>({
  name: 'backups.targets.create',
  description:
    'Adds a backup target, a restic repository every scheduled run (settings.backupCron) backs up to while enabled',
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
    assertSecretFitsKind(input.kind, input.secret);
    const secretEnc = sealTargetSecret(keyringFromEnv(env), input.secret);
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
