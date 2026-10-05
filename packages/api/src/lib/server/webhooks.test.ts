import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nowIso, type Db, type Envelope } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { testKeyring } from '#testing/fixtures.js';

import { encrypt, type Keyring } from './secretbox.js';
import { WebhookDispatcher } from './webhooks.js';

const FAILING_STATUS = 500;
const DELIVERY_ATTEMPTS = 3;

/** Skips the real backoff delay so the three-attempt tests run instantly. */
function noDelay(): Promise<void> {
  return Promise.resolve();
}

type StubRequest = { headers: http.IncomingHttpHeaders; body: string };

/**
 * A local HTTP receiver that records every POST and answers with `status` until changed, on
 * whatever port is free: a fixed port can already be held by another suite on the same host.
 */
async function startStub(): Promise<{
  url: string;
  requests: StubRequest[];
  setStatus: (status: number) => void;
  close: () => Promise<void>;
}> {
  const requests: StubRequest[] = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      requests.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setStatus: value => {
      status = value;
    },
    close: () =>
      new Promise(resolve => {
        server.close(() => {
          resolve();
        });
      })
  };
}

async function insertWebhook(
  db: Db,
  kr: Keyring,
  options: {
    id?: string;
    url: string;
    active?: number;
    secret?: string;
    eventTypesJson?: string | null;
  }
): Promise<void> {
  await db
    .insertInto('webhooks')
    .values({
      id: options.id ?? 'hook-1',
      url: options.url,
      eventTypesJson: options.eventTypesJson ?? null,
      active: options.active ?? 1,
      secretEnc: encrypt(kr, 'webhooks.secretEnc', options.secret ?? 'shh'),
      createdAt: nowIso()
    })
    .execute();
}

async function lastStatusOf(db: Db): Promise<string | null> {
  const row = await db
    .selectFrom('webhooks')
    .select('lastStatus')
    .where('id', '=', 'hook-1')
    .executeTakeFirstOrThrow();
  return row.lastStatus;
}

async function pendingDeliveries(
  db: Db
): Promise<{ attempts: number; nextAttemptAt: string }[]> {
  return db
    .selectFrom('webhookDeliveries')
    .select(['attempts', 'nextAttemptAt'])
    .execute();
}

/**
 * A dispatcher at `now` whose first retry never comes, as in an `api` that stops during the
 * backoff: `retrying` settles once the failed first attempt is on disk and the wait has begun.
 */
function stoppedAtFirstRetry(
  db: Db,
  kr: Keyring,
  now: string
): { dispatcher: WebhookDispatcher; retrying: Promise<undefined> } {
  const retrying = Promise.withResolvers<undefined>();
  const dispatcher = new WebhookDispatcher({
    db,
    kr,
    now: () => now,
    delay: () => {
      retrying.resolve(undefined);
      return Promise.withResolvers<undefined>().promise;
    }
  });
  return { dispatcher, retrying: retrying.promise };
}

function sampleEvent(): Envelope {
  return {
    id: 'evt-1',
    at: nowIso(),
    type: 'trunk.status',
    trunkId: 't1',
    status: 'unreachable'
  };
}

describe('WebhookDispatcher', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(() => stub.close());

  it("signs the body with the hook's secret", async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url, secret: 'top-secret' });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });
    const ev = sampleEvent();

    await dispatcher.enqueue(ev);

    expect(stub.requests).toHaveLength(1);
    const [request] = stub.requests;
    if (request === undefined) {
      throw new Error('webhooks test: expected a request');
    }
    const expectedSignature = createHmac('sha256', 'top-secret')
      .update(request.body)
      .digest('hex');
    expect(request.headers['x-zamfono-signature']).toBe(expectedSignature);
    expect(JSON.parse(request.body)).toEqual(ev);
  });

  it('posts a call.state event in the §10.6 shape, without its internal participant list', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url, secret: 'top-secret' });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });
    const ev: Envelope = {
      id: 'evt-2',
      at: nowIso(),
      type: 'call.state',
      callId: 'c1',
      legs: [],
      state: 'up',
      peer: '+15550100',
      ringGroupId: null,
      userId: 'u2',
      userIds: ['u1', 'u2']
    };

    await dispatcher.enqueue(ev);

    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(stub.requests[0]?.body ?? '')).toEqual({
      id: 'evt-2',
      at: ev.at,
      type: 'call.state',
      callId: 'c1',
      state: 'up',
      peer: '+15550100',
      ringGroupId: null,
      userId: 'u2',
      legs: []
    });
  });

  it('posts nothing for a call.state event meant for the users it names alone (§10.6)', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url, secret: 'top-secret' });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });

    await dispatcher.enqueue({
      id: 'evt-3',
      at: nowIso(),
      type: 'call.state',
      callId: 'c1',
      legs: [],
      state: 'ended',
      peer: '+15550100',
      ringGroupId: 'group-1',
      userId: null,
      userIds: ['u1'],
      usersOnly: true
    });

    expect(stub.requests).toHaveLength(0);
    expect(
      await db.selectFrom('webhookDeliveries').selectAll().execute()
    ).toEqual([]);
  });

  it('marks the hook failing after three failed attempts, and ok on the next success', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });
    stub.setStatus(FAILING_STATUS);

    await dispatcher.enqueue(sampleEvent());

    expect(stub.requests).toHaveLength(DELIVERY_ATTEMPTS);
    expect(await lastStatusOf(db)).toBe('failing');

    stub.setStatus(200);
    await dispatcher.enqueue(sampleEvent());

    expect(await lastStatusOf(db)).toBe('ok');
  });

  it('sends nothing to an inactive hook', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url, active: 0 });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });

    await dispatcher.enqueue(sampleEvent());

    expect(stub.requests).toHaveLength(0);
  });

  it("skips a hook whose event-type filter excludes the event's type", async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, {
      url: stub.url,
      eventTypesJson: JSON.stringify(['backup.failed'])
    });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });

    await dispatcher.enqueue(sampleEvent());

    expect(stub.requests).toHaveLength(0);
  });

  it('a hook with an unparsable event-type filter never blocks delivery to the others', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, {
      id: 'hook-bad-filter',
      url: stub.url,
      eventTypesJson: 'not json'
    });
    await insertWebhook(db, kr, { id: 'hook-2', url: stub.url });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });

    await dispatcher.enqueue(sampleEvent());

    expect(stub.requests).toHaveLength(1);
    const badFilterHook = await db
      .selectFrom('webhooks')
      .select('lastStatus')
      .where('id', '=', 'hook-bad-filter')
      .executeTakeFirstOrThrow();
    expect(badFilterHook.lastStatus).toBeNull();
  });

  it('leaves nothing in the outbox once a delivery is delivered or given up', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });

    await dispatcher.enqueue(sampleEvent());
    stub.setStatus(FAILING_STATUS);
    await dispatcher.enqueue(sampleEvent());

    expect(await pendingDeliveries(db)).toEqual([]);
  });
});

describe('WebhookDispatcher across a restart', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(() => stub.close());

  it('resumes a retrying delivery with its attempt count, waiting out the rest of its backoff', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url, secret: 'top-secret' });
    stub.setStatus(FAILING_STATUS);
    const first = stoppedAtFirstRetry(db, kr, '2026-10-01T10:00:00.000Z');
    // Never settles: this process stops during the backoff.
    first.dispatcher.enqueue(sampleEvent()).catch(() => undefined);
    await first.retrying;

    expect(stub.requests).toHaveLength(1);
    expect(await pendingDeliveries(db)).toEqual([
      { attempts: 1, nextAttemptAt: '2026-10-01T10:00:01.000Z' }
    ]);

    stub.setStatus(200);
    const delays: number[] = [];
    const second = new WebhookDispatcher({
      db,
      kr,
      now: () => '2026-10-01T10:00:00.400Z',
      delay: ms => {
        delays.push(ms);
        return Promise.resolve();
      }
    });
    await second.resume();

    expect(delays).toEqual([600]);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1]?.body).toBe(stub.requests[0]?.body);
    expect(stub.requests[1]?.headers['x-zamfono-signature']).toBe(
      createHmac('sha256', 'top-secret')
        .update(stub.requests[0]?.body ?? '')
        .digest('hex')
    );
    expect(JSON.parse(stub.requests[1]?.body ?? '')).toMatchObject({
      id: 'evt-1'
    });
    expect(await pendingDeliveries(db)).toEqual([]);
    expect(await lastStatusOf(db)).toBe('ok');
  });

  it('gives a resumed delivery only the attempts it has left', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url });
    await db
      .insertInto('webhookDeliveries')
      .values({
        id: 'delivery-1',
        webhookId: 'hook-1',
        bodyJson: JSON.stringify(sampleEvent()),
        attempts: 2,
        nextAttemptAt: '2026-10-01T10:00:00.000Z',
        createdAt: '2026-10-01T09:59:55.000Z'
      })
      .execute();
    stub.setStatus(FAILING_STATUS);

    await new WebhookDispatcher({ db, kr, delay: noDelay }).resume();

    expect(stub.requests).toHaveLength(1);
    expect(await pendingDeliveries(db)).toEqual([]);
    expect(await lastStatusOf(db)).toBe('failing');
  });

  it('drops a retrying delivery whose hook is deleted, without a status', async () => {
    const db = await migratedTestDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url });
    stub.setStatus(FAILING_STATUS);
    const retry = Promise.withResolvers<undefined>();
    const retrying = Promise.withResolvers<undefined>();
    const dispatcher = new WebhookDispatcher({
      db,
      kr,
      delay: () => {
        retrying.resolve(undefined);
        return retry.promise;
      }
    });
    const delivery = dispatcher.enqueue(sampleEvent());
    await retrying.promise;

    await db
      .updateTable('webhooks')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'hook-1')
      .execute();
    retry.resolve(undefined);
    await delivery;

    expect(stub.requests).toHaveLength(1);
    expect(await pendingDeliveries(db)).toEqual([]);
    expect(await lastStatusOf(db)).toBeNull();
  });
});
