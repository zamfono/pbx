import { z } from 'zod';

import { defineOperation } from '../types.js';
import { assertDeviceScope, liveDevice } from './_shared.js';

/** `GET /devices/{id}/blf` (§10.4, §11.2): a ringotel device's ordered BLF panel. */
export const getBlf = defineOperation({
  name: 'devices.getBlf',
  description: "Reads a ringotel device's BLF panel.",
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const device = await liveDevice(ctx.db, input.id);
    assertDeviceScope(ctx.actor.role, ctx.actor.id, device);
    const rows = await ctx.db
      .selectFrom('deviceBlfKeys')
      .select('ext')
      .where('deviceId', '=', input.id)
      .orderBy('position')
      .execute();
    return { keys: rows.map(row => row.ext) };
  }
});
