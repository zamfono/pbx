import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import { fromFlag, recordChange, recordFieldChanges } from '../audit.js';
import { orBefore } from '../patch.js';
import { defineOperation } from '../types.js';
import {
  decodeEventTypes,
  eventTypesField,
  httpUrlSchema,
  liveWebhook,
  toWire,
  webhookSecretSchema,
  webhookWire
} from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    url: httpUrlSchema.optional(),
    secret: webhookSecretSchema.optional(),
    eventTypes: eventTypesField,
    active: z
      .boolean()
      .optional()
      .describe(
        'Whether events are delivered; off on creation, switched on once the receiver is ready.'
      )
  })
  .strict();

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
export const update = defineOperation({
  name: 'webhooks.update',
  description:
    "Changes a webhook's URL, secret or event-type filter, or switches it on or off",
  input: inputSchema,
  output: webhookWire,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  entity: input => ({ kind: 'webhook', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveWebhook(ctx.db, input.id);
    const url = orBefore(input.url, before.url);
    const active = orBefore(input.active, before.active === 1);
    const eventTypesJson = nextEventTypesJson(
      before.eventTypesJson,
      input.eventTypes
    );
    const secretEnc =
      input.secret === undefined
        ? before.secretEnc
        : encrypt(keyringFromEnv(env), 'webhooks.secretEnc', input.secret);
    const columns = { url, active: active ? 1 : 0, eventTypesJson };
    recordFieldChanges(ctx, before, columns, {
      active: { decode: fromFlag },
      eventTypesJson: { field: 'eventTypes', decode: decodeEventTypes }
    });
    if (input.secret !== undefined) {
      recordChange(ctx, { field: 'secret', from: null, to: input.secret });
    }
    await ctx.db
      .updateTable('webhooks')
      .set({ ...columns, secretEnc })
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
