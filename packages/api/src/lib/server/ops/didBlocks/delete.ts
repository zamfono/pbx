import { z } from 'zod';

import { softDelete } from '../rows.js';
import { propagate } from '../runner.js';
import { Conflict, defineOperation } from '../types.js';
import { liveDidBlock, liveDidsInBlock } from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /didBlocks/{id}` (§5.9, §11.3): soft-deletes a block once no live DID falls within it. */
export const del = defineOperation({
  name: 'didBlocks.delete',
  description: 'Soft-deletes a number block once no live DID falls within it',
  input: inputSchema,
  minRole: 'admin',
  confirm: input => `Delete number block ${input.id}?`,
  entity: input => ({ kind: 'didBlock', id: input.id }),
  run: async (ctx, input) => {
    const block = await liveDidBlock(ctx.db, input.id);
    const liveDids = await liveDidsInBlock(ctx.db, block);
    if (liveDids.length > 0) {
      throw new Conflict(
        'didBlocks: live DIDs within the block',
        liveDids.map(did => ({ kind: 'did', id: did.id, label: did.number }))
      );
    }
    await softDelete(ctx, 'didBlocks', input.id);
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
