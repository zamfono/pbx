import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { Db, DB, Event } from '@zamfono/shared';

import { liveRow } from '../rows.js';

export type WebhookRow = Selectable<DB['webhooks']>;

/** Every `Event.type` a webhook's `event_types_json` filter may name (§10.6). */
export const EVENT_TYPES = [
  'presence',
  'call.state',
  'voicemail.new',
  'ooo',
  'hours',
  'trunk.status',
  'history.appended',
  'backup.started',
  'backup.finished',
  'backup.failed'
] as const satisfies readonly Event['type'][];

export type EventType = (typeof EVENT_TYPES)[number];

export const eventTypeSchema = z.enum(EVENT_TYPES);

/** A webhook's `secret`, the same field on create and update (§10.6). */
export const webhookSecretSchema = z
  .string()
  .min(1)
  .describe(
    'Shared secret: each POST carries X-Zamfono-Signature, the HMAC-SHA256 of the body under it; write-only.'
  );

/** A webhook's event-type filter, the same field on create and update (§10.6). */
export const eventTypesSchema = z
  .array(eventTypeSchema)
  .nullable()
  .optional()
  .describe(
    'The event types to deliver, such as ["call.state", "voicemail.new"]; null delivers every event.'
  );

/** A webhook's `url`: `http(s)` only, since it names an HTTP POST endpoint (§10.6). */
export const httpUrlSchema = z
  .url({ protocol: /^https?$/u })
  .describe('The http(s) endpoint every event is POSTed to as JSON.');

/** `event_types_json` parsed back to the wire shape: `null` unfiltered, an array of `EventType`. */
export function parseEventTypesJson(json: string | null): EventType[] | null {
  return json === null ? null : (JSON.parse(json) as EventType[]);
}

export type WebhookWire = {
  id: string;
  url: string;
  eventTypes: EventType[] | null;
  active: boolean;
  lastStatus: 'failing' | 'ok' | null;
  lastDeliveryAt: string | null;
  /** When the hook turned `failing`, and the deliveries failed since; `null` and 0 while not. */
  failingSince: string | null;
  failedDeliveries: number;
  /** Why the last delivery that failed did, such as `HTTP 404` or `timeout`, and when. */
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
};

/** `row` as `GET /webhooks` returns it; the secret is write-only and never appears here (§10.6). */
export function toWire(row: WebhookRow): WebhookWire {
  return {
    id: row.id,
    url: row.url,
    eventTypes: parseEventTypesJson(row.eventTypesJson),
    active: row.active === 1,
    lastStatus: row.lastStatus as 'failing' | 'ok' | null,
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
