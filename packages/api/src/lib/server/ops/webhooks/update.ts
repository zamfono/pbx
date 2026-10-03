import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import { orBefore } from '../patch.js';
import { recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import {
  eventTypesSchema,
  httpUrlSchema,
  loadLiveWebhook,
  parseEventTypesJson,
  toWire,
  webhookSecretSchema,
  type WebhookWire
} from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    url: httpUrlSchema.optional(),
    secret: webhookSecretSchema.optional(),
    eventTypes: eventTypesSchema,
    active: z
      .boolean()
      .optional()
      .describe(
        'Whether events are delivered; off on creation, switched on once the receiver is ready.'
      )
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** The next `event_types_json` value: unchanged while `eventTypes` is absent (§10.6). */
function nextEventTypesJson(
  before: string | null,
  eventTypes: string[] | null | undefined
): string | null {
  if (eventTypes === undefined) {
    return before;
  }
  if (eventTypes === null) {
    return null;
  }
  return JSON.stringify(eventTypes);
}

/** `PATCH /webhooks/{id}` (§10.6): URL, secret, event-type filter and the `active` switch. */
export const update = defineOperation<Input, WebhookWire>({
  name: 'webhooks.update',
  description:
    "Changes a webhook's URL, secret or event-type filter, or switches it on or off",
  input: inputSchema,
  minRole: 'admin',
  entity: input => ({ kind: 'webhook', id: input.id }),
  run: async (ctx, input) => {
    const before = await loadLiveWebhook(ctx.db, input.id);
    if (!before) {
      throw new OpError(HTTP_NOT_FOUND, 'webhooks: webhook not found');
    }
    const url = orBefore(input.url, before.url);
    const active = orBefore(input.active, before.active === 1);
    const eventTypesJson = nextEventTypesJson(
      before.eventTypesJson,
      input.eventTypes
    );
    const secretEnc =
      input.secret === undefined
        ? before.secretEnc
        : encrypt(keyringFromEnv(env), input.secret);
    if (url !== before.url) {
      recordChange(ctx, { field: 'url', from: before.url, to: url });
    }
    if (active !== (before.active === 1)) {
      recordChange(ctx, {
        field: 'active',
        from: before.active === 1,
        to: active
      });
    }
    if (eventTypesJson !== before.eventTypesJson) {
      recordChange(ctx, {
        field: 'eventTypes',
        from: parseEventTypesJson(before.eventTypesJson),
        to: parseEventTypesJson(eventTypesJson)
      });
    }
    if (input.secret !== undefined) {
      recordChange(ctx, { field: 'secret', from: null, to: input.secret });
    }
    await ctx.db
      .updateTable('webhooks')
      .set({ url, active: active ? 1 : 0, eventTypesJson, secretEnc })
      .where('id', '=', input.id)
      .execute();
    const row = await ctx.db
      .selectFrom('webhooks')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    return toWire(row);
  }
});
