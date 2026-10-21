import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { deviceKey, loadDeviceKeys } from './_keys.js';
import { liveDevice, ownTlsDevice } from './_shared.js';

/** `GET /devices/{id}/blf` (§10.4, §11.2): a device's ordered key list. */
export const getBlf = defineOperation({
  name: 'devices.getBlf',
  description:
    "Reads a device's key list: a ringotel device's BLF panel, or a manual device's line keys.",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ keys: z.array(deviceKey) }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownTlsDevice,
  readOnly: true,
  run: async (ctx, input) => {
    await liveDevice(ctx.db, input.id);
    return { keys: await loadDeviceKeys(ctx.db, input.id) };
  }
});
