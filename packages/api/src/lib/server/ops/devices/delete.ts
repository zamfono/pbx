import { z } from 'zod';

import { activeRingotelProvider } from '#lib/server/provisioning/index.js';

import { propagate } from '../propagate.js';
import { softDelete } from '../rows.js';
import { defineOperation } from '../types.js';
import { liveDevice, ownTlsDevice } from './_shared.js';

/** `DELETE /devices/{id}` (§10.3): soft-deletes a device. */
export const deleteDevice = defineOperation({
  name: 'devices.delete',
  description: 'Soft-deletes a device.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  scope: ownTlsDevice,
  confirm: input => `Delete this device? (${input.id})`,
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
