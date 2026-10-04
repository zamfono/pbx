import { z } from 'zod';

import { HTTP_BAD_GATEWAY, HTTP_NOT_FOUND } from '@zamfono/shared';

import { propagate } from '../propagate.js';
import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import { defineOperation } from '../types.js';
import { releaseRingotelUsers } from './_ringotelDeletion.js';
import { liveDevice, ownTlsDevice } from './_shared.js';

/**
 * `DELETE /devices/{id}` (§10.3): soft-deletes a device; a `ringotel` device's Ringotel user is
 * deleted first, before the transaction opens (§10.4), and Ringotel's refusal is a 502.
 */
export const deleteDevice = defineOperation({
  name: 'devices.delete',
  description: 'Soft-deletes a device.',
  input: z.object({ id: z.string() }).strict(),
  output: idOutput,
  problems: [HTTP_NOT_FOUND, HTTP_BAD_GATEWAY],
  minRole: 'user',
  scope: ownTlsDevice,
  confirm: async (ctx, input) =>
    softDeleteQuestion(
      ctx,
      `the device ${(await liveDevice(ctx.db, input.id)).label}`
    ),
  entity: input => ({ kind: 'device', id: input.id }),
  prepare: async (ctx, input) =>
    releaseRingotelUsers(ctx, [await liveDevice(ctx.db, input.id)]),
  run: async (ctx, input, release) => {
    // Deleted meanwhile by another call: 404, as before Ringotel was asked.
    await liveDevice(ctx.db, input.id);
    await softDelete(ctx, 'devices', input.id);
    propagate(ctx, ['pjsip']);
    release();
    return { id: input.id };
  }
});
