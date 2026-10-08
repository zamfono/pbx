/**
 * Webhooks (`ops/webhooks/`, §10.6): endpoints every event, or the filtered types, is POSTed to,
 * signed with the hook's secret. Created inactive; the secret is required and write-only, so a
 * write that sets it is masked in the audit diff and not undoable.
 */
import { invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import {
  EVENT_TYPES,
  type ChangeEntry,
  type EventType,
  type Webhook
} from '../../types';
import { defineOp } from '../core';

export type WebhookWire = Omit<Webhook, 'deletedAt'>;

const MASK = '•••';

const toWire = ({ deletedAt: _deleted, ...wire }: Webhook): WebhookWire => wire;

function checkUrl(value: unknown): string {
  let url: URL | null = null;
  try {
    url = typeof value === 'string' ? new URL(value.trim()) : null;
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw invalid('url', 'webhookUrl', 'url must be an http(s) URL');
  }
  return String(value).trim();
}

function checkSecret(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw invalid('secret', 'webhookSecret', 'secret is required');
  }
  return value;
}

function checkEventTypes(value: unknown): EventType[] | null {
  if (value === null) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.some(type => !EVENT_TYPES.includes(type as EventType))
  ) {
    throw invalid(
      'eventTypes',
      'webhookEventTypes',
      'eventTypes must be event types'
    );
  }
  return EVENT_TYPES.filter(type => value.includes(type));
}

function liveWebhook(webhooks: Webhook[], id: string): Webhook {
  const row = webhooks.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (row === undefined) {
    throw notFound('webhook', id);
  }
  return row;
}

defineOp<
  { limit?: number; cursor?: string },
  { items: WebhookWire[]; nextCursor: null }
>({
  name: 'webhooks.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.webhooks.filter(row => row.deletedAt === null).map(toWire),
    nextCursor: null
  })
});

defineOp<
  { url: string; secret: string; eventTypes?: EventType[] | null },
  WebhookWire
>({
  name: 'webhooks.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const url = checkUrl(input.url);
    checkSecret(input.secret);
    const eventTypes =
      input.eventTypes === undefined ? null : checkEventTypes(input.eventTypes);
    const row: Webhook = {
      id: newId(),
      url,
      secretSet: true,
      eventTypes,
      active: false,
      lastStatus: null,
      lastDeliveryAt: null,
      failingSince: null,
      failedDeliveries: 0,
      lastError: null,
      lastErrorAt: null,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('webhooks', row);
    ctx.audit({
      entityKind: 'webhook',
      entityId: row.id,
      changes: [
        { field: 'url', from: null, to: url },
        { field: 'secret', from: MASK, to: MASK }
      ],
      undoable: false
    });
    return toWire(row);
  }
});

defineOp<
  {
    id: string;
    url?: string;
    secret?: string;
    eventTypes?: EventType[] | null;
    active?: boolean;
  },
  WebhookWire
>({
  name: 'webhooks.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const before = liveWebhook(ctx.db.webhooks, input.id);
    const after: Webhook = { ...before };
    if (input.url !== undefined) {
      after.url = checkUrl(input.url);
    }
    if (input.eventTypes !== undefined) {
      after.eventTypes = checkEventTypes(input.eventTypes);
    }
    if (input.active !== undefined) {
      after.active = input.active;
    }
    const changes: ChangeEntry[] = (['url', 'active', 'eventTypes'] as const)
      .filter(
        field => JSON.stringify(before[field]) !== JSON.stringify(after[field])
      )
      .map(field => ({ field, from: before[field], to: after[field] }));
    if (input.secret !== undefined) {
      checkSecret(input.secret);
      changes.push({ field: 'secret', from: MASK, to: MASK });
    }
    if (changes.length === 0) {
      return toWire(before);
    }
    ctx.put('webhooks', after);
    ctx.audit({
      entityKind: 'webhook',
      entityId: after.id,
      changes,
      undoable: input.secret === undefined
    });
    return toWire(after);
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'webhooks.delete',
  minRole: 'admin',
  confirm: (ctx, input) => ({
    key: 'webhooks.delete',
    params: { url: liveWebhook(ctx.db.webhooks, input.id).url },
    destructive: true
  }),
  run: (ctx, input) => {
    const before = { ...liveWebhook(ctx.db.webhooks, input.id) };
    ctx.softDelete('webhooks', before.id);
    ctx.audit({
      entityKind: 'webhook',
      entityId: before.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: before.id };
  }
});
