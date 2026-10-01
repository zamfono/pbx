/**
 * Signed webhook delivery (§10.6): every active hook matching an event's type gets an
 * at-least-once HTTP POST from the `webhook_deliveries` outbox, so a queued or retrying delivery
 * survives an `api` restart and resumes with its attempt count and backoff.
 */
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { newId, publicEnvelope, type Db, type Envelope } from '@zamfono/shared';

import { tryParseJson } from './json.js';
import { decrypt, type Keyring } from './secretbox.js';

// §10.6: three attempts total per delivery, a 5 s timeout per request, and the two backoff
// delays between them.
const REQUEST_TIMEOUT_MS = 5000;
const DELIVERY_ATTEMPTS = 3;
const FIRST_RETRY_DELAY_MS = 1000;
const SECOND_RETRY_DELAY_MS = 4000;
const RETRY_BACKOFF_MS = [FIRST_RETRY_DELAY_MS, SECOND_RETRY_DELAY_MS];
const SIGNATURE_HEADER = 'X-Zamfono-Signature';

type WebhookRow = {
  id: string;
  eventTypesJson: string | null;
};

/** A `webhook_deliveries` row: one event's body on its way to one hook. */
type DeliveryRow = {
  id: string;
  webhookId: string;
  bodyJson: string;
  attempts: number;
  nextAttemptAt: string;
};

/**
 * `true` when `hook`'s optional event-type filter admits `eventType`; `null` means every type.
 * An unparsable filter admits nothing, so one malformed row never blocks delivery to the other
 * hooks matching the same event.
 */
function matchesFilter(hook: WebhookRow, eventType: string): boolean {
  if (hook.eventTypesJson === null) {
    return true;
  }
  const types = tryParseJson(hook.eventTypesJson);
  return Array.isArray(types) && types.includes(eventType);
}

/** The wait before retry `retry` (1-based), from `RETRY_BACKOFF_MS`. */
function backoffMs(retry: number): number {
  const delay = RETRY_BACKOFF_MS[retry - 1];
  // `RETRY_BACKOFF_MS` has one entry per retry (`DELIVERY_ATTEMPTS - 1`), so this is always
  // in range.
  if (delay === undefined) {
    throw new Error(`webhooks: no backoff for retry ${retry}`);
  }
  return delay;
}

export type WebhookDispatcherDeps = {
  db: Db;
  kr: Keyring;
  fetchImpl?: typeof fetch;
  delay?: (ms: number) => Promise<void>;
  now?: () => string;
};

type ResolvedDeps = {
  db: Db;
  kr: Keyring;
  fetchImpl: typeof fetch;
  delay: (ms: number) => Promise<void>;
  now: () => string;
};

/**
 * Delivers events to the `webhooks` table's active, matching hooks: HMAC-SHA256 of the JSON
 * body in `X-Zamfono-Signature`, three attempts with backoff, and the resulting `last_status`.
 * Each pending delivery is a `webhook_deliveries` row, removed once it is delivered or given up.
 */
export class WebhookDispatcher {
  private readonly deps: ResolvedDeps;

  constructor(deps: WebhookDispatcherDeps) {
    this.deps = {
      db: deps.db,
      kr: deps.kr,
      fetchImpl: deps.fetchImpl ?? fetch,
      delay: deps.delay ?? (ms => sleep(ms)),
      now: deps.now ?? (() => new Date().toISOString())
    };
  }

  /**
   * Queues `ev` for every active hook whose filter admits it and delivers it. Resolves once
   * every hook's attempts (success or exhausted retries) have settled.
   */
  async enqueue(ev: Envelope): Promise<void> {
    if (ev.type === 'call.state' && ev.usersOnly === true) {
      // News to the users it names alone (`visibleTo`): the call's own state is unchanged.
      return;
    }
    const hooks = await this.deps.db
      .selectFrom('webhooks')
      .select(['id', 'eventTypesJson'])
      .where('active', '=', 1)
      .where('deletedAt', 'is', null)
      .execute();
    const matching = hooks.filter(hook => matchesFilter(hook, ev.type));
    if (matching.length === 0) {
      return;
    }
    // §10.6: the event as subscribers receive it, without the internal routing fields.
    const bodyJson = JSON.stringify(publicEnvelope(ev));
    const now = this.deps.now();
    const rows: DeliveryRow[] = matching.map(hook => ({
      id: newId(),
      webhookId: hook.id,
      bodyJson,
      attempts: 0,
      nextAttemptAt: now
    }));
    await this.deps.db
      .insertInto('webhookDeliveries')
      .values(rows.map(row => ({ ...row, createdAt: now })))
      .execute();
    await Promise.all(rows.map(row => this.deliver(row)));
  }

  /**
   * Picks up every delivery a previous `api` process left pending: each waits out what remains
   * of its backoff and goes on from its attempt count. Resolves once all have settled.
   */
  async resume(): Promise<void> {
    const rows = await this.deps.db
      .selectFrom('webhookDeliveries')
      .select(['id', 'webhookId', 'bodyJson', 'attempts', 'nextAttemptAt'])
      .orderBy('id')
      .execute();
    await Promise.all(rows.map(row => this.deliver(row)));
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    let { attempts, nextAttemptAt } = row;
    for (;;) {
      const waitMs = Date.parse(nextAttemptAt) - Date.parse(this.deps.now());
      if (waitMs > 0) {
        // eslint-disable-next-line no-await-in-loop -- each retry waits out the backoff the previous failure set
        await this.deps.delay(waitMs);
      }
      // eslint-disable-next-line no-await-in-loop -- attempts are sequential by design: a retry only happens after the previous one failed
      const delivered = await this.attempt(row);
      if (delivered === null) {
        return;
      }
      attempts += 1;
      if (delivered || attempts >= DELIVERY_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop -- the last step of the loop, which ends it
        await this.settle(row, delivered);
        return;
      }
      nextAttemptAt = new Date(
        Date.parse(this.deps.now()) + backoffMs(attempts)
      ).toISOString();
      // eslint-disable-next-line no-await-in-loop -- the retry's state is on disk before it waits
      await this.deps.db
        .updateTable('webhookDeliveries')
        .set({ attempts, nextAttemptAt })
        .where('id', '=', row.id)
        .execute();
    }
  }

  /**
   * One POST of `row`'s body, signed with its hook's current secret: whether it succeeded, or
   * `null` when the delivery is gone or its hook deleted, which ends it with no status.
   */
  private async attempt(row: DeliveryRow): Promise<boolean | null> {
    const hook = await this.deps.db
      .selectFrom('webhookDeliveries')
      .innerJoin('webhooks', 'webhooks.id', 'webhookDeliveries.webhookId')
      .select(['webhooks.url', 'webhooks.secretEnc'])
      .where('webhookDeliveries.id', '=', row.id)
      .where('webhooks.deletedAt', 'is', null)
      .executeTakeFirst();
    if (hook === undefined) {
      await this.deps.db
        .deleteFrom('webhookDeliveries')
        .where('id', '=', row.id)
        .execute();
      return null;
    }
    const secret = decrypt(this.deps.kr, hook.secretEnc).toString('utf8');
    const signature = createHmac('sha256', secret)
      .update(row.bodyJson)
      .digest('hex');
    return this.post(hook.url, row.bodyJson, signature);
  }

  /** Removes `row` from the outbox and records its outcome as the hook's `last_status`. */
  private async settle(row: DeliveryRow, delivered: boolean): Promise<void> {
    const now = this.deps.now();
    await this.deps.db.transaction().execute(async trx => {
      await trx
        .deleteFrom('webhookDeliveries')
        .where('id', '=', row.id)
        .execute();
      await trx
        .updateTable('webhooks')
        .set({ lastStatus: delivered ? 'ok' : 'failing', lastDeliveryAt: now })
        .where('id', '=', row.webhookId)
        .execute();
    });
  }

  private async post(
    url: string,
    body: string,
    signature: string
  ): Promise<boolean> {
    try {
      const response = await this.deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGNATURE_HEADER]: signature
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
