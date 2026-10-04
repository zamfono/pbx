import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import { defineOperation } from '../types.js';
import { liveWebhook } from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/**
 * `DELETE /webhooks/{id}` (§10.6, §5.9): soft-deletes a webhook and drops its pending deliveries,
 * which an undo does not bring back.
 */
export const del = defineOperation({
  name: 'webhooks.delete',
  description: 'Soft-deletes a webhook; its events are no longer delivered',
  input: inputSchema,
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) =>
    softDeleteQuestion(
      ctx,
      `the webhook to ${(await liveWebhook(ctx.db, input.id)).url}`
    ),
  entity: input => ({ kind: 'webhook', id: input.id }),
  run: async (ctx, input) => {
    await liveWebhook(ctx.db, input.id);
    await softDelete(ctx, 'webhooks', input.id);
    await ctx.db
      .deleteFrom('webhookDeliveries')
      .where('webhookId', '=', input.id)
      .execute();
    return { id: input.id };
  }
});
