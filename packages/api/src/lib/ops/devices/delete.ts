import { z } from 'zod';

import { activeRingotelProvider } from '../../provisioning/index.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import { assertDeviceScope, liveDevice } from './_shared.js';

/** `DELETE /devices/{id}` (§10.3): soft-deletes a device. */
export const deleteDevice = defineOperation({
  name: 'devices.delete',
  description: 'Soft-deletes a device.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  confirm: input => `Delete this device? (${input.id})`,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveDevice(ctx.db, input.id);
    assertDeviceScope(ctx.actor.role, ctx.actor.id, before);
    await ctx.db
      .updateTable('devices')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    propagate(ctx, ['pjsip']);
    if (before.kind === 'ringotel') {
      const provider = await activeRingotelProvider(ctx.db);
      await provider?.onDeviceDeleted(before);
    }
    return { id: input.id };
  }
});
