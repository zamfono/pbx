import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';

/**
 * `GET /parking/calls` (§10.2 "Call parking", §10.3 "Live calls"): the calls parked right now,
 * one per occupied slot, read from `core`'s live state. Every user sees them, as every phone's
 * BLF shows every slot: the slot, the call, the parked party's number (`null` when withheld),
 * since when and by whom. Dialling the slot retrieves the call (`calls.originate`).
 */
export const list = defineOperation({
  name: 'parking.list',
  description:
    'Lists the calls parked right now: slot, call, caller (null when withheld), parked since and by whom.',
  input: z.object({}).strict(),
  minRole: 'user',
  readOnly: true,
  run: async () => {
    const { parked } = await getCoreClient().parked();
    return { items: parked, nextCursor: null };
  }
});
