import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError } from '../types.js';
import { liveDidsInBlock, loadLiveDidBlock } from './_shared.js';

const STATUS_NOT_FOUND = 404;

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
    const block = await loadLiveDidBlock(ctx.db, input.id);
    if (!block) {
      throw new OpError(STATUS_NOT_FOUND, 'didBlocks: block not found');
    }
    const liveDids = await liveDidsInBlock(ctx.db, block);
    if (liveDids.length > 0) {
      throw new Conflict(
        'didBlocks: live DIDs within the block',
        liveDids.map(did => ({ kind: 'did', id: did.id, label: did.number }))
      );
    }
    await ctx.db
      .updateTable('didBlocks')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
