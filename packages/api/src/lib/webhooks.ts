/**
 * Signed webhook delivery (§10.6): every active hook matching an event's type gets an
 * at-least-once HTTP POST, from an in-memory queue that is lost on restart.
 */
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { publicEnvelope, type Db, type Envelope } from '@zamfono/shared';

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
  url: string;
  eventTypesJson: string | null;
  secretEnc: Buffer;
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

export type WebhookDispatcherDeps = {
  db: Db;
  kr: Keyring;
  fetchImpl?: typeof fetch;
  delay?: (ms: number) => Promise<void>;
  now?: () => string;
};

/**
 * Delivers events to the `webhooks` table's active, matching hooks: HMAC-SHA256 of the JSON
 * body in `X-Zamfono-Signature`, three attempts with backoff, and the resulting `last_status`.
 */
type ResolvedDeps = {
  db: Db;
  kr: Keyring;
  fetchImpl: typeof fetch;
  delay: (ms: number) => Promise<void>;
  now: () => string;
};

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
   * Delivers `ev` to every active hook whose filter admits it. Resolves once every hook's
   * attempts (success or exhausted retries) have settled; never rejects.
   */
  async enqueue(ev: Envelope): Promise<void> {
    const hooks = await this.deps.db
      .selectFrom('webhooks')
      .select(['id', 'url', 'eventTypesJson', 'secretEnc'])
      .where('active', '=', 1)
      .where('deletedAt', 'is', null)
      .execute();
    const matching = hooks.filter(hook => matchesFilter(hook, ev.type));
    await Promise.all(matching.map(hook => this.deliverOne(hook, ev)));
  }

  private async deliverOne(hook: WebhookRow, ev: Envelope): Promise<void> {
    const secret = decrypt(this.deps.kr, hook.secretEnc).toString('utf8');
    // §10.6: the event as subscribers receive it, without the internal routing fields.
    const body = JSON.stringify(publicEnvelope(ev));
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    let delivered = false;
    for (
      let attempt = 0;
      attempt < DELIVERY_ATTEMPTS && !delivered;
      attempt += 1
    ) {
      if (attempt > 0) {
        const backoffMs = RETRY_BACKOFF_MS[attempt - 1];
        // `RETRY_BACKOFF_MS` has one entry per retry (`DELIVERY_ATTEMPTS - 1`), so this is
        // always in range.
        if (backoffMs === undefined) {
          throw new Error(`webhooks: no backoff for retry ${attempt}`);
        }
        // eslint-disable-next-line no-await-in-loop -- each retry's delay depends on the previous attempt's failure
        await this.deps.delay(backoffMs);
      }
      // eslint-disable-next-line no-await-in-loop -- attempts are sequential by design: a retry only happens after the previous one failed
      delivered = await this.attempt(hook.url, body, signature);
    }
    await this.deps.db
      .updateTable('webhooks')
      .set({
        lastStatus: delivered ? 'ok' : 'failing',
        lastDeliveryAt: this.deps.now()
      })
      .where('id', '=', hook.id)
      .execute();
  }

  private async attempt(
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
