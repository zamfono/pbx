import { z } from 'zod';

import { HTTP_BAD_GATEWAY, HTTP_NOT_FOUND } from '@zamfono/shared';

import { activeRingotelProvider } from '#lib/server/provisioning/index.js';

import { propagate } from '../propagate.js';
import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import { defineOperation } from '../types.js';
import { liveDevice, ownTlsDevice } from './_shared.js';

/** `DELETE /devices/{id}` (§10.3): soft-deletes a device. */
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
  run: async (ctx, input) => {
    const before = await liveDevice(ctx.db, input.id);
    await softDelete(ctx, 'devices', input.id);
    propagate(ctx, ['pjsip']);
    if (before.kind === 'ringotel') {
      const provider = await activeRingotelProvider(ctx.db);
      await provider?.onDeviceDeleted(before);
    }
    return { id: input.id };
  }
});
