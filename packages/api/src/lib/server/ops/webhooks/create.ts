import * as env from '$app/env/private';
import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import { recordChange } from '../audit.js';
import { recordHeaderChange, storeHeaders } from '../httpHeaders.js';
import { defineOperation } from '../types.js';
import {
  eventTypesField,
  httpUrlSchema,
  toWire,
  webhookHeadersField,
  webhookSecretSchema,
  webhookWire,
  type WebhookWire
} from './_shared.js';

const inputSchema = z
  .object({
    url: httpUrlSchema,
    secret: webhookSecretSchema,
    eventTypes: eventTypesField,
    headers: webhookHeadersField
  })
  .strict();

/**
 * `POST /webhooks` (§10.6): a new event receiver, always created inactive so an admin switches
 * it on once the endpoint is ready to receive deliveries.
 */
export const create = defineOperation({
  name: 'webhooks.create',
  description:
    'Adds a webhook, an endpoint every event (or the filtered types) is POSTed to; created inactive until switched on with webhooks.update',
  input: inputSchema,
  output: webhookWire,
  minRole: 'admin',
  entity: (_input, output: WebhookWire) => ({ kind: 'webhook', id: output.id }),
  run: async (ctx, input) => {
    const id = newId();
    const eventTypes = input.eventTypes ?? null;
    const kr = keyringFromEnv(env);
    const secretEnc = encrypt(kr, 'webhooks.secretEnc', input.secret);
    const headers = storeHeaders(
      kr,
      'webhooks.secretHeadersEnc',
      input.headers ?? []
    );
    await ctx.db
      .insertInto('webhooks')
      .values({
        id,
        url: input.url,
        eventTypesJson: eventTypes === null ? null : JSON.stringify(eventTypes),
        active: 0,
        secretEnc,
        ...headers,
        lastStatus: null,
        lastDeliveryAt: null,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'url', from: null, to: input.url });
    recordChange(ctx, { field: 'secret', from: null, to: input.secret });
    recordHeaderChange(ctx, '[]', headers.headersJson);
    const row = await ctx.db
      .selectFrom('webhooks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toWire(row);
  }
});
