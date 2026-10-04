import { getCoreClient } from '#lib/server/coreClient.js';
import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

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
  input: pageInput.strict(),
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { parked } = await getCoreClient().parked();
    const { page, nextCursor } = offsetPage(
      ctx.operation,
      parked.slice(offset, offset + input.limit + 1),
      offset,
      input.limit
    );
    return { items: page, nextCursor };
  }
});
