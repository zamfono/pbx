import { z } from 'zod';

import { liveRow, softDelete } from '../rows.js';
import { propagate } from '../runner.js';
import { defineOperation } from '../types.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /blockedNumbers/{id}` (§10.3 "Blocklist"): soft-deletes a blocklist entry. */
export const del = defineOperation({
  name: 'blockedNumbers.delete',
  description: 'Removes a number from the tenant blocklist',
  input: inputSchema,
  minRole: 'admin',
  confirm: input => `Unblock ${input.id}?`,
  entity: input => ({ kind: 'blockedNumber', id: input.id }),
  run: async (ctx, input) => {
    await liveRow(
      ctx.db,
      'blockedNumbers',
      input.id,
      'blockedNumbers: not found'
    );
    await softDelete(ctx, 'blockedNumbers', input.id);
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
