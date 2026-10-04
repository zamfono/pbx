import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  eventTypesColumn,
  eventTypesSchema,
  WEBHOOK_STATUSES,
  type Db,
  type DB,
  type EventType
} from '@zamfono/shared';

import { liveRow } from '../rows.js';

export type WebhookRow = Selectable<DB['webhooks']>;

/** A webhook's `secret`, the same field on create and update (§10.6). */
export const webhookSecretSchema = z
  .string()
  .min(1)
  .describe(
    'Shared secret: each POST carries X-Zamfono-Signature, the HMAC-SHA256 of the body under it; write-only, read as secretSet; required, so null is refused.'
  );

/** A webhook's event-type filter, the same field on create and update (§10.6). */
export const eventTypesField = eventTypesSchema
  .nullable()
  .optional()
  .describe(
    'The event types to deliver, such as ["call.state", "voicemail.new"]; null delivers every event.'
  );

/** A webhook's `url`: `http(s)` only, since it names an HTTP POST endpoint (§10.6). */
export const httpUrlSchema = z
  .url({ protocol: /^https?$/u })
  .describe('The http(s) endpoint every event is POSTed to as JSON.');

/** `event_types_json` as the wire shape: `null` unfiltered, else the types delivered. */
export function decodeEventTypes(json: string | null): EventType[] | null {
  return eventTypesColumn.nullable().decode(json);
}

/** A webhook's wire shape (§10.3, §10.6), as `toWire` assembles it. */
export const webhookWire = z.object({
  id: z.string(),
  url: z.string(),
  eventTypes: eventTypesSchema.nullable(),
  secretSet: z
    .literal(true)
    .describe(
      "Always true: a hook's secret is required; the secret itself is write-only."
    ),
  active: z.boolean(),
  lastStatus: z.enum(WEBHOOK_STATUSES).nullable(),
  lastDeliveryAt: z.string().nullable(),
  failingSince: z
    .string()
    .nullable()
    .describe('When the hook turned failing; null while it is not.'),
  failedDeliveries: z
    .number()
    .describe('The deliveries failed since failingSince; 0 while not failing.'),
  lastError: z
    .string()
    .nullable()
    .describe(
      'Why the last delivery that failed did, such as HTTP 404 or timeout.'
    ),
  lastErrorAt: z.string().nullable(),
  createdAt: z.string()
});
export type WebhookWire = z.infer<typeof webhookWire>;

/** `row` as `GET /webhooks` returns it; the secret is write-only, only `secretSet` shows it (§10.3). */
export function toWire(row: WebhookRow): WebhookWire {
  return {
    id: row.id,
    url: row.url,
    eventTypes: decodeEventTypes(row.eventTypesJson),
    secretSet: true,
    active: row.active === 1,
    lastStatus: row.lastStatus,
    lastDeliveryAt: row.lastDeliveryAt,
    failingSince: row.failingSince,
    failedDeliveries: row.failedDeliveries,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    createdAt: row.createdAt
  };
}

/** The live `webhooks` row with `id`, or `OpError(404)`. */
export async function liveWebhook(db: Db, id: string): Promise<WebhookRow> {
  return liveRow(db, 'webhooks', id, 'webhooks: webhook not found');
}
