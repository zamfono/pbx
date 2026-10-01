import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/secretbox.js';

import { recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  eventTypesSchema,
  httpUrlSchema,
  toWire,
  webhookSecretSchema,
  type WebhookWire
} from './_shared.js';

const inputSchema = z
  .object({
    url: httpUrlSchema,
    secret: webhookSecretSchema,
    eventTypes: eventTypesSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/**
 * `POST /webhooks` (§10.6): a new event receiver, always created inactive so an admin switches
 * it on once the endpoint is ready to receive deliveries.
 */
export const create = defineOperation<Input, WebhookWire>({
  name: 'webhooks.create',
  description:
    'Adds a webhook, an endpoint every event (or the filtered types) is POSTed to; created inactive until switched on with webhooks.update',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, output: WebhookWire) => ({ kind: 'webhook', id: output.id }),
  run: async (ctx, input) => {
    const id = newId();
    const eventTypes = input.eventTypes ?? null;
    const secretEnc = encrypt(keyringFromEnv(process.env), input.secret);
    await ctx.db
      .insertInto('webhooks')
      .values({
        id,
        url: input.url,
        eventTypesJson: eventTypes === null ? null : JSON.stringify(eventTypes),
        active: 0,
        secretEnc,
        lastStatus: null,
        lastDeliveryAt: null,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'url', from: null, to: input.url });
    recordChange(ctx, { field: 'secret', from: null, to: input.secret });
    const row = await ctx.db
      .selectFrom('webhooks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toWire(row);
  }
});
