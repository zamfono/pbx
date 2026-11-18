/**
 * Signed webhook delivery (§10.6): every active hook matching an event's type, and every
 * after-call request of an attempted forward target, gets an at-least-once HTTP request from the
 * `webhook_deliveries` outbox, so a queued or retrying delivery
 * survives an `api` restart and resumes with its attempt count and backoff. A delivery's end moves
 * its hook's health and logs what changed (`webhookHealth.ts`).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import {
  isSuccess,
  newId,
  nowIso,
  publicEnvelope,
  sendHttpRequest,
  type AfterCallReport,
  type Db,
  type Envelope,
  type HttpAnswer,
  type HttpSend,
  type TargetPolicy
} from '@zamfono/shared';

import { afterCallDeliveries, afterCallSend } from './afterCallDelivery.js';
import type { Keyring } from './secretbox.js';
import { errorReason, httpReason } from './webhookFailure.js';
import { settleDelivery } from './webhookHealth.js';
import { backoffMs, DELIVERY_ATTEMPTS, matchesFilter } from './webhookRules.js';
import { webhookSend } from './webhookSend.js';

// §10.6: a 5 s timeout per request.
const REQUEST_TIMEOUT_MS = 5000;

/** A `webhook_deliveries` row: one event's body on its way to one hook. */
type DeliveryRow = {
  id: string;
  webhookId: string | null;
  afterCallRequestId: string | null;
  bodyJson: string;
  attempts: number;
  nextAttemptAt: string;
};

/**
 * One attempt's outcome: `failure` `null` when it was delivered, else why not, and whether a
 * failure is worth another attempt.
 */
type AttemptOutcome = { failure: string | null; retryable: boolean };

export type WebhookDispatcherDeps = {
  db: Db;
  kr: Keyring;
  /** The addresses a hook may be delivered to (§3.1 "Outbound targets"), from
   *  `ALLOW_PRIVATE_TARGETS`; `null` delivers to any, for a test's receiver on loopback. */
  targetPolicy: TargetPolicy | null;
  /** Overridable in tests; by default the one request sender, `sendHttpRequest`. */
  send?: (send: HttpSend) => Promise<HttpAnswer>;
  delay?: (ms: number) => Promise<void>;
  now?: () => string;
  /** What an after-call request's recording links are signed with and open under (§10.6), read
   *  as one is built; left out by a dispatcher that delivers events alone. */
  links?: () => { jwtSecret: string; origin: string };
};

type ResolvedDeps = {
  db: Db;
  kr: Keyring;
  targetPolicy: TargetPolicy | null;
  send: (send: HttpSend) => Promise<HttpAnswer>;
  delay: (ms: number) => Promise<void>;
  now: () => string;
  links: (() => { jwtSecret: string; origin: string }) | null;
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
      targetPolicy: deps.targetPolicy,
      send: deps.send ?? sendHttpRequest,
      delay: deps.delay ?? (ms => sleep(ms)),
      now: deps.now ?? nowIso,
      links: deps.links ?? null
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
    const matching = hooks.filter(hook =>
      matchesFilter(hook.eventTypesJson, ev.type)
    );
    if (matching.length === 0) {
      return;
    }
    // §10.6: the event as subscribers receive it, without the internal routing fields.
    const bodyJson = JSON.stringify(publicEnvelope(ev));
    const now = this.deps.now();
    const rows: DeliveryRow[] = matching.map(hook => ({
      id: newId(),
      webhookId: hook.id,
      afterCallRequestId: null,
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
   * Queues the after-call request of each attempt of `report`'s call whose forward target has
   * one (§10.6 "After-call requests") and delivers it. Resolves once every one has settled.
   */
  async enqueueAfterCall(report: AfterCallReport): Promise<void> {
    const now = this.deps.now();
    const rows: DeliveryRow[] = (
      await afterCallDeliveries(this.deps.db, report)
    ).map(delivery => ({
      id: newId(),
      webhookId: null,
      ...delivery,
      attempts: 0,
      nextAttemptAt: now
    }));
    if (rows.length === 0) {
      return;
    }
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
      .select([
        'id',
        'webhookId',
        'afterCallRequestId',
        'bodyJson',
        'attempts',
        'nextAttemptAt'
      ])
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
      const outcome = await this.attempt(row);
      if (outcome === null) {
        return;
      }
      attempts += 1;
      if (
        outcome.failure === null ||
        !outcome.retryable ||
        attempts >= DELIVERY_ATTEMPTS
      ) {
        // eslint-disable-next-line no-await-in-loop -- the last step of the loop, which ends it
        await settleDelivery(
          this.deps.db,
          row,
          outcome.failure,
          this.deps.now()
        );
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
   * One send of `row`: an event to its hook, or an after-call request built anew
   * (`webhookSend.ts`, `afterCallDelivery.ts`). `null` when the delivery's owner is gone or
   * switched off, which ends it with no status; a failure no later attempt could mend, a secret
   * that cannot be decrypted (§5.4) among them, fails the delivery for good.
   */
  private async attempt(row: DeliveryRow): Promise<AttemptOutcome | null> {
    const { db, kr, now, links } = this.deps;
    let built: Awaited<ReturnType<typeof webhookSend>> = null;
    if (row.afterCallRequestId === null) {
      built = await webhookSend({ db, kr }, row);
    } else if (links !== null) {
      built = await afterCallSend(
        { db, kr, now, ...links() },
        { afterCallRequestId: row.afterCallRequestId, bodyJson: row.bodyJson }
      );
    }
    if (built === null) {
      await db
        .deleteFrom('webhookDeliveries')
        .where('id', '=', row.id)
        .execute();
      return null;
    }
    if ('failure' in built) {
      return { failure: built.failure, retryable: false };
    }
    const failure = await this.post({
      ...built.send,
      timeoutMs: REQUEST_TIMEOUT_MS,
      policy: this.deps.targetPolicy
    });
    return { failure, retryable: true };
  }

  /** Sends `send`: `null` once the receiver answered 2xx, else why not (`webhookHealth.ts`). */
  private async post(send: HttpSend): Promise<string | null> {
    try {
      const { status } = await this.deps.send(send);
      return isSuccess(status) ? null : httpReason(status);
    } catch (error) {
      return errorReason(error);
    }
  }
}
