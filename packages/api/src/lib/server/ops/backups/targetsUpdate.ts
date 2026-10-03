import * as env from '$app/env/private';
import { z } from 'zod';

import { keyringFromEnv } from '#lib/server/secretbox.js';

import { orBefore } from '../patch.js';
import { liveRow } from '../rows.js';
import { recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  assertSecretFitsKind,
  openTargetSecret,
  sealTargetSecret
} from './_secret.js';
import {
  targetFields,
  targetToWire,
  withDefaultForgetPolicy,
  type BackupTargetWire
} from './_shared.js';

const inputSchema = z
  .object({ id: z.string(), ...z.object(targetFields).partial().shape })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** `PATCH /backups/targets/{id}` (§6.5 "Backups"): kind, params, secret and the enabled flag. */
export const targetsUpdate = defineOperation<Input, BackupTargetWire>({
  name: 'backups.targets.update',
  description:
    "Changes a backup target's kind, location, secret or enabled flag",
  input: inputSchema,
  minRole: 'admin',
  entity: input => ({ kind: 'backupTarget', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveRow(
      ctx.db,
      'backupTargets',
      input.id,
      'backups: target not found'
    );
    const kind = orBefore(input.kind, before.kind);
    const enabled = orBefore(input.enabled, before.enabled === 1);
    const paramsJson =
      input.params === undefined
        ? before.paramsJson
        : JSON.stringify(withDefaultForgetPolicy(input.params));
    const kr = keyringFromEnv(env);
    // A new kind takes other credentials: the stored secret must fit it, unless a new one comes.
    if (input.secret !== undefined || kind !== before.kind) {
      assertSecretFitsKind(
        kind,
        input.secret ?? openTargetSecret(kr, before.secretEnc)
      );
    }
    const secretEnc =
      input.secret === undefined
        ? before.secretEnc
        : sealTargetSecret(kr, input.secret);
    if (kind !== before.kind) {
      recordChange(ctx, { field: 'kind', from: before.kind, to: kind });
    }
    if (enabled !== (before.enabled === 1)) {
      recordChange(ctx, {
        field: 'enabled',
        from: before.enabled === 1,
        to: enabled
      });
    }
    if (paramsJson !== before.paramsJson) {
      recordChange(ctx, {
        field: 'params',
        from: JSON.parse(before.paramsJson) as Record<string, unknown>,
        to: JSON.parse(paramsJson) as Record<string, unknown>
      });
    }
    if (input.secret !== undefined) {
      recordChange(ctx, { field: 'secret', from: null, to: input.secret });
    }
    await ctx.db
      .updateTable('backupTargets')
      .set({ kind, paramsJson, enabled: enabled ? 1 : 0, secretEnc })
      .where('id', '=', input.id)
      .execute();
    const row = await ctx.db
      .selectFrom('backupTargets')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    return targetToWire(row);
  }
});
