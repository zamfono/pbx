/**
 * A webhook's delivery health (§10.6 "Webhooks"): why a delivery failed, in a short reason that
 * names the HTTP status or the class of error, and how a settled delivery moves the hook's
 * `last_status` and failure columns (`settleDelivery`), with the log line that move calls for. A hook's failure is
 * logged when it turns `failing`, whenever its reason changes while it stays failing, and once a
 * day while it keeps failing for the same reason; its recovery is logged too.
 */
import type { Selectable } from 'kysely';
import pino from 'pino';

import { isRecord, MS_PER_DAY, type DB, type Db } from '@zamfono/shared';

import { tryParseJson } from './json.js';

const logger = pino({ name: 'webhooks' });

type HookRow = Selectable<DB['webhooks']>;

/** The columns a settled delivery reads. */
export type HookHealth = Pick<
  HookRow,
  | 'id'
  | 'url'
  | 'lastStatus'
  | 'lastError'
  | 'failingSince'
  | 'failedDeliveries'
  | 'lastLoggedAt'
>;

/** The columns a settled delivery writes. */
export type HealthUpdate = Pick<
  HookRow,
  'lastStatus' | 'lastDeliveryAt' | 'failingSince' | 'lastLoggedAt'
> &
  Partial<Pick<HookRow, 'lastError' | 'lastErrorAt'>> & {
    failedDeliveries: number;
  };

/** A delivery's end: `failure` `null` when it was delivered, else why its last attempt failed. */
export type Settled = { failure: string | null; eventType: string; at: string };

type LogLine = { level: 'info' | 'warn'; fields: object; msg: string };

/** `url` without credentials or query, which may carry a receiver's token. */
function loggedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(unparsable URL)';
  }
}

/** The log line, if any, for a delivery that failed for `failure`. */
function failureLine(
  hook: HookHealth,
  fields: {
    webhookId: string;
    url: string;
    eventType: string;
    failedDeliveries: number;
  },
  failure: string,
  at: string
): LogLine | null {
  const line = (msg: string): LogLine => ({
    level: 'warn',
    fields: { ...fields, reason: failure },
    msg
  });
  if (hook.lastStatus !== 'failing') {
    return line(
      `webhooks: the hook for ${fields.url} is failing: ${failure} delivering ${fields.eventType}`
    );
  }
  if (failure !== hook.lastError) {
    return line(
      `webhooks: the hook for ${fields.url} is still failing, now ${failure} (was ${hook.lastError ?? 'unknown'}) delivering ${fields.eventType}`
    );
  }
  const loggedMs =
    hook.lastLoggedAt === null ? 0 : Date.parse(hook.lastLoggedAt);
  if (Date.parse(at) - loggedMs >= MS_PER_DAY) {
    return line(
      `webhooks: the hook for ${fields.url} is still failing: ${failure}, ${String(fields.failedDeliveries)} deliveries failed since ${hook.failingSince ?? 'unknown'}`
    );
  }
  return null;
}

/** The hook's columns after `settled`, and the log line it calls for, if any. */
export function settleHealth(
  hook: HookHealth,
  settled: Settled
): { update: HealthUpdate; log: LogLine | null } {
  const { failure, eventType, at } = settled;
  const url = loggedUrl(hook.url);
  const webhookId = hook.id;
  const wasFailing = hook.lastStatus === 'failing';
  if (failure === null) {
    const update = {
      lastStatus: 'ok',
      lastDeliveryAt: at,
      failingSince: null,
      failedDeliveries: 0,
      lastLoggedAt: null
    };
    const log: LogLine | null = wasFailing
      ? {
          level: 'info',
          fields: {
            webhookId,
            url,
            eventType,
            failedDeliveries: hook.failedDeliveries
          },
          msg: `webhooks: the hook for ${url} delivers again, after ${String(hook.failedDeliveries)} failed deliveries since ${hook.failingSince ?? 'unknown'}`
        }
      : null;
    return { update, log };
  }
  const failedDeliveries = wasFailing ? hook.failedDeliveries + 1 : 1;
  const log = failureLine(
    hook,
    { webhookId, url, eventType, failedDeliveries },
    failure,
    at
  );
  const update = {
    lastStatus: 'failing',
    lastDeliveryAt: at,
    lastError: failure,
    lastErrorAt: at,
    failingSince: wasFailing ? (hook.failingSince ?? at) : at,
    failedDeliveries,
    lastLoggedAt: log === null ? hook.lastLoggedAt : at
  };
  return { update, log };
}

/** The `type` of the event `bodyJson` carries, for the log. */
function eventTypeOf(bodyJson: string): string {
  const body = tryParseJson(bodyJson);
  return isRecord(body) && typeof body.type === 'string'
    ? body.type
    : 'unknown';
}

/**
 * Removes a delivery from the outbox and records its end on its hook, `last_status` and the
 * failure columns, logging what changed once the write committed. `failure` is `null` for a
 * delivery that was delivered, else why its last attempt failed.
 */
export async function settleDelivery(
  db: Db,
  delivery: { id: string; webhookId: string; bodyJson: string },
  failure: string | null,
  at: string
): Promise<void> {
  const settled = { failure, eventType: eventTypeOf(delivery.bodyJson), at };
  const log = await db.transaction().execute(async trx => {
    await trx
      .deleteFrom('webhookDeliveries')
      .where('id', '=', delivery.id)
      .execute();
    const hook = await trx
      .selectFrom('webhooks')
      .select([
        'id',
        'url',
        'lastStatus',
        'lastError',
        'failingSince',
        'failedDeliveries',
        'lastLoggedAt'
      ])
      .where('id', '=', delivery.webhookId)
      .executeTakeFirst();
    if (hook === undefined) {
      return null;
    }
    const next = settleHealth(hook, settled);
    await trx
      .updateTable('webhooks')
      .set(next.update)
      .where('id', '=', delivery.webhookId)
      .execute();
    return next.log;
  });
  if (log !== null) {
    logger[log.level](log.fields, log.msg);
  }
}
