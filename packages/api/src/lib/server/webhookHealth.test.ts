import { describe, expect, it, vi } from 'vitest';

import {
  MS_PER_DAY,
  MS_PER_HOUR,
  nowIso,
  type Db,
  type Envelope
} from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { testKeyring } from '#testing/fixtures.js';

import { encrypt, type Keyring } from './secretbox.js';
import { errorReason, SECRET_UNREADABLE } from './webhookFailure.js';
import { WebhookDispatcher } from './webhooks.js';

type Logged = { level: string; fields: Record<string, unknown>; msg: string };

const logged = vi.hoisted((): Logged[] => []);

vi.mock('pino', () => ({
  default: () => ({
    info: (fields: Record<string, unknown>, msg: string) => {
      logged.push({ level: 'info', fields, msg });
    },
    warn: (fields: Record<string, unknown>, msg: string) => {
      logged.push({ level: 'warn', fields, msg });
    },
    error: () => undefined
  })
}));

const URL = 'https://crm.example/hooks/zamfono?token=abc';

function noDelay(): Promise<void> {
  return Promise.resolve();
}

function event(id: string): Envelope {
  return {
    id,
    at: nowIso(),
    type: 'trunk.status',
    trunkId: 't1',
    status: 'unreachable'
  };
}

/**
 * A dispatcher on a fresh database with one active hook, whose receiver answers `status.next`
 * (a number for an HTTP status, an Error for a request that gets no response), on a clock the
 * test moves; `logged` starts empty.
 */
async function setUp(secretKeyring?: Keyring): Promise<{
  db: Db;
  dispatcher: WebhookDispatcher;
  answer: { next: number | Error };
  clock: { ms: number };
  posts: { count: number };
}> {
  logged.length = 0;
  const db = await migratedTestDb();
  const kr = testKeyring();
  await db
    .insertInto('webhooks')
    .values({
      id: 'hook-1',
      url: URL,
      eventTypesJson: null,
      active: 1,
      secretEnc: encrypt(secretKeyring ?? kr, 'shh'),
      createdAt: nowIso()
    })
    .execute();
  const answer: { next: number | Error } = { next: 200 };
  const clock = { ms: Date.parse('2026-10-01T09:00:00.000Z') };
  const posts = { count: 0 };
  const fetchImpl: typeof fetch = () => {
    posts.count += 1;
    const { next } = answer;
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(new Response(null, { status: next }));
  };
  const dispatcher = new WebhookDispatcher({
    db,
    kr,
    fetchImpl,
    delay: noDelay,
    now: () => new Date(clock.ms).toISOString()
  });
  return { db, dispatcher, answer, clock, posts };
}

async function hookOf(db: Db): Promise<Record<string, unknown>> {
  return db
    .selectFrom('webhooks')
    .select([
      'lastStatus',
      'lastError',
      'lastErrorAt',
      'failingSince',
      'failedDeliveries',
      'lastLoggedAt'
    ])
    .where('id', '=', 'hook-1')
    .executeTakeFirstOrThrow();
}

describe('webhook failure logging', () => {
  it('logs the turn to failing, then again when the reason changes from 404 to 403', async () => {
    const { db, dispatcher, answer, clock } = await setUp();

    answer.next = 404;
    await dispatcher.enqueue(event('e1'));
    clock.ms += MS_PER_HOUR;
    answer.next = 403;
    await dispatcher.enqueue(event('e2'));

    expect(logged).toEqual([
      {
        level: 'warn',
        fields: {
          webhookId: 'hook-1',
          url: 'https://crm.example/hooks/zamfono',
          eventType: 'trunk.status',
          failedDeliveries: 1,
          reason: 'HTTP 404'
        },
        msg: 'webhooks: the hook for https://crm.example/hooks/zamfono is failing: HTTP 404 delivering trunk.status'
      },
      {
        level: 'warn',
        fields: expect.objectContaining({
          failedDeliveries: 2,
          reason: 'HTTP 403'
        }) as unknown,
        msg: 'webhooks: the hook for https://crm.example/hooks/zamfono is still failing, now HTTP 403 (was HTTP 404) delivering trunk.status'
      }
    ]);
    expect(await hookOf(db)).toEqual({
      lastStatus: 'failing',
      lastError: 'HTTP 403',
      lastErrorAt: '2026-10-01T10:00:00.000Z',
      failingSince: '2026-10-01T09:00:00.000Z',
      failedDeliveries: 2,
      lastLoggedAt: '2026-10-01T10:00:00.000Z'
    });
  });

  it('logs the same reason once, then once a day while it keeps failing', async () => {
    const { db, dispatcher, answer, clock } = await setUp();
    answer.next = new DOMException('timed out', 'TimeoutError');

    await dispatcher.enqueue(event('e1'));
    clock.ms += MS_PER_HOUR;
    await dispatcher.enqueue(event('e2'));
    expect(logged).toHaveLength(1);

    clock.ms += MS_PER_DAY - MS_PER_HOUR - 1;
    await dispatcher.enqueue(event('e3'));
    expect(logged).toHaveLength(1);
    clock.ms += 1;
    await dispatcher.enqueue(event('e4'));
    clock.ms += MS_PER_HOUR;
    await dispatcher.enqueue(event('e5'));

    expect(logged).toHaveLength(2);
    expect(logged[1]).toEqual({
      level: 'warn',
      fields: expect.objectContaining({
        reason: 'timeout',
        failedDeliveries: 4
      }) as unknown,
      msg: 'webhooks: the hook for https://crm.example/hooks/zamfono is still failing: timeout, 4 deliveries failed since 2026-10-01T09:00:00.000Z'
    });
    expect(await hookOf(db)).toMatchObject({
      failedDeliveries: 5,
      lastLoggedAt: '2026-10-02T09:00:00.000Z'
    });
  });

  it('logs the recovery and clears the failing state', async () => {
    const { db, dispatcher, answer, clock } = await setUp();
    answer.next = 503;
    await dispatcher.enqueue(event('e1'));
    await dispatcher.enqueue(event('e2'));

    clock.ms += MS_PER_HOUR;
    answer.next = 204;
    await dispatcher.enqueue(event('e3'));
    await dispatcher.enqueue(event('e4'));

    expect(logged.map(line => line.level)).toEqual(['warn', 'info']);
    expect(logged[1]?.msg).toBe(
      'webhooks: the hook for https://crm.example/hooks/zamfono delivers again, after 2 failed deliveries since 2026-10-01T09:00:00.000Z'
    );
    expect(await hookOf(db)).toEqual({
      lastStatus: 'ok',
      lastError: 'HTTP 503',
      lastErrorAt: '2026-10-01T09:00:00.000Z',
      failingSince: null,
      failedDeliveries: 0,
      lastLoggedAt: null
    });
  });

  it('drops a delivery whose secret cannot be decrypted at once, marks the hook and logs once', async () => {
    const { db, dispatcher, posts } = await setUp(testKeyring());

    await dispatcher.enqueue(event('e1'));
    await dispatcher.enqueue(event('e2'));

    expect(posts.count).toBe(0);
    expect(
      await db.selectFrom('webhookDeliveries').selectAll().execute()
    ).toEqual([]);
    expect(await hookOf(db)).toMatchObject({
      lastStatus: 'failing',
      lastError: SECRET_UNREADABLE,
      failedDeliveries: 2
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.msg).toBe(
      'webhooks: the hook for https://crm.example/hooks/zamfono is failing: secret unreadable — set a new secret delivering trunk.status'
    );
  });

  it('drops a pending delivery with an unreadable secret at resume, without a retry', async () => {
    const { db, dispatcher, posts } = await setUp(testKeyring());
    await db
      .insertInto('webhookDeliveries')
      .values({
        id: 'd1',
        webhookId: 'hook-1',
        bodyJson: JSON.stringify(event('e1')),
        attempts: 1,
        nextAttemptAt: '2026-10-01T09:00:00.000Z',
        createdAt: '2026-10-01T08:59:59.000Z'
      })
      .execute();

    await dispatcher.resume();

    expect(posts.count).toBe(0);
    expect(
      await db.selectFrom('webhookDeliveries').selectAll().execute()
    ).toEqual([]);
    expect((await hookOf(db)).lastError).toBe(SECRET_UNREADABLE);
  });
});

describe('errorReason', () => {
  /** An error as `fetch` rejects with, wrapping a socket error with `code`. */
  function fetchFailed(code: string): Error {
    return new TypeError('fetch failed', {
      cause: Object.assign(new Error(code), { code })
    });
  }

  it.each([
    [new DOMException('timed out', 'TimeoutError'), 'timeout'],
    [fetchFailed('ECONNREFUSED'), 'connection refused'],
    [fetchFailed('ECONNRESET'), 'connection reset'],
    [fetchFailed('ENOTFOUND'), 'DNS lookup failed'],
    [fetchFailed('CERT_HAS_EXPIRED'), 'TLS error CERT_HAS_EXPIRED'],
    [
      fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID'),
      'TLS error ERR_TLS_CERT_ALTNAME_INVALID'
    ],
    [fetchFailed('EPIPE'), 'network error EPIPE'],
    [new TypeError('fetch failed'), 'network error']
  ])('names %s %j', (error, reason) => {
    expect(errorReason(error)).toBe(reason);
  });
});
