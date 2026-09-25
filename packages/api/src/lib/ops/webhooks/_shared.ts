import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { Db, DB, Event } from '@zamfono/shared';

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

/** A webhook's `url`: `http(s)` only, since it names an HTTP POST endpoint (§10.6). */
export const httpUrlSchema = z.url({ protocol: /^https?$/u });

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
    createdAt: row.createdAt
  };
}

/** Loads a live `webhooks` row by id, or `undefined` when absent or soft-deleted. */
export async function loadLiveWebhook(
  db: Db,
  id: string
): Promise<WebhookRow | undefined> {
  return db
    .selectFrom('webhooks')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}
