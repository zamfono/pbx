import * as env from '$app/env/private';
import { z } from 'zod';

import { backupParamsColumn, HTTP_NOT_FOUND } from '@zamfono/shared';

import {
  fromFlag,
  recordChange,
  recordFieldChanges
} from '#lib/server/ops/audit.js';
import { orBefore } from '#lib/server/ops/patch.js';
import { liveRow } from '#lib/server/ops/rows.js';
import { defineOperation } from '#lib/server/ops/types.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import {
  assertSecretFitsKind,
  openTargetSecret,
  sealTargetSecret
} from '../_secret.js';
import {
  backupTargetWire,
  targetFields,
  targetToWire,
  withDefaultForgetPolicy
} from '../_shared.js';

const inputSchema = z
  .object({ id: z.string(), ...z.object(targetFields).partial().shape })
  .strict();

/** `PATCH /backups/targets/{id}` (§6.5 "Backups"): kind, params, secret and the enabled flag. */
export const targetsUpdate = defineOperation({
  name: 'backups.targets.update',
  description:
    "Changes a backup target's kind, location, secret or enabled flag",
  input: inputSchema,
  output: backupTargetWire,
  problems: [HTTP_NOT_FOUND],
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
    const columns = { kind, enabled: enabled ? 1 : 0, paramsJson };
    recordFieldChanges(ctx, before, columns, {
      enabled: { decode: fromFlag },
      paramsJson: {
        field: 'params',
        decode: stored => backupParamsColumn.decode(stored)
      }
    });
    if (input.secret !== undefined) {
      recordChange(ctx, { field: 'secret', from: null, to: input.secret });
    }
    await ctx.db
      .updateTable('backupTargets')
      .set({ ...columns, secretEnc })
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
