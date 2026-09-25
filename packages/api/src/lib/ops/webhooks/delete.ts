import { z } from 'zod';

import { recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { loadLiveWebhook } from './_shared.js';

const STATUS_NOT_FOUND = 404;

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /webhooks/{id}` (§10.6, §5.9): soft-deletes a webhook. */
export const del = defineOperation({
  name: 'webhooks.delete',
  description: 'Removes a webhook',
  input: inputSchema,
  minRole: 'admin',
  confirm: input => `Delete webhook ${input.id}?`,
  entity: input => ({ kind: 'webhook', id: input.id }),
  run: async (ctx, input) => {
    const webhook = await loadLiveWebhook(ctx.db, input.id);
    if (!webhook) {
      throw new OpError(STATUS_NOT_FOUND, 'webhooks: webhook not found');
    }
    await ctx.db
      .updateTable('webhooks')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    return { id: input.id };
  }
});
