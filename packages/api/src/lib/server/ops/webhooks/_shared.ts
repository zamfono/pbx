import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  eventTypesColumn,
  eventTypesSchema,
  type Db,
  type DB,
  type EventType,
  type WebhookStatus
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

export type WebhookWire = {
  id: string;
  url: string;
  eventTypes: EventType[] | null;
  /** Always `true`: a hook's secret is required; the secret itself is write-only (§10.3). */
  secretSet: true;
  active: boolean;
  lastStatus: WebhookStatus | null;
  lastDeliveryAt: string | null;
  /** When the hook turned `failing`, and the deliveries failed since; `null` and 0 while not. */
  failingSince: string | null;
  failedDeliveries: number;
  /** Why the last delivery that failed did, such as `HTTP 404` or `timeout`, and when. */
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
};

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
