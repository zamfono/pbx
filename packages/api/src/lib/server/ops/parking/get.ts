import { z } from 'zod';

import { defineOperation } from '../types.js';
import { loadParkingSlots, slotsOutput } from './_shared.js';

/** `GET /parking/slots` (§10.3 "Parking"): the current set of parking-slot extensions. */
export const get = defineOperation({
  name: 'parking.get',
  description: 'Reads the set of parking-slot extensions',
  input: z.object({}),
  output: slotsOutput,
  minRole: 'admin',
  readOnly: true,
  run: async ctx => ({ slots: await loadParkingSlots(ctx.db) })
});
