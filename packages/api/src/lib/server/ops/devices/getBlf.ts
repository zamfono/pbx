import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { liveDevice, ownTlsDevice } from './_shared.js';

/** `GET /devices/{id}/blf` (§10.4, §11.2): a ringotel device's ordered BLF panel. */
export const getBlf = defineOperation({
  name: 'devices.getBlf',
  description: "Reads a ringotel device's BLF panel.",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ keys: z.array(z.string()) }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownTlsDevice,
  readOnly: true,
  run: async (ctx, input) => {
    await liveDevice(ctx.db, input.id);
    const rows = await ctx.db
      .selectFrom('deviceBlfKeys')
      .select('ext')
      .where('deviceId', '=', input.id)
      .orderBy('position')
      .execute();
    return { keys: rows.map(row => row.ext) };
  }
});
