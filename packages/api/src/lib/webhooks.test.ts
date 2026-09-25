import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nowIso, openDb, type Db, type Envelope } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { encrypt, keyringFromEnv, type Keyring } from './secretbox.js';
import { WebhookDispatcher } from './webhooks.js';

const KEY_BYTE_LENGTH = 32;
const FAILING_STATUS = 500;
const DELIVERY_ATTEMPTS = 3;

function testKeyring(): Keyring {
  return keyringFromEnv({
    SECRETBOX_KEY: `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`
  });
}

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

async function migratedDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  return db;
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
      secretEnc: encrypt(kr, options.secret ?? 'shh'),
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
  // eslint-disable-next-line init-declarations -- assigned in beforeEach, closed in afterEach
  let stub: Awaited<ReturnType<typeof startStub>>;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(() => stub.close());

  it("signs the body with the hook's secret", async () => {
    const db = await migratedDb();
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
    const db = await migratedDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url, secret: 'top-secret' });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });
    const ev: Envelope = {
      id: 'evt-2',
      at: nowIso(),
      type: 'call.state',
      callId: 'c1',
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
      userId: 'u2'
    });
  });

  it('marks the hook failing after three failed attempts, and ok on the next success', async () => {
    const db = await migratedDb();
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
    const db = await migratedDb();
    const kr = testKeyring();
    await insertWebhook(db, kr, { url: stub.url, active: 0 });
    const dispatcher = new WebhookDispatcher({ db, kr, delay: noDelay });

    await dispatcher.enqueue(sampleEvent());

    expect(stub.requests).toHaveLength(0);
  });

  it("skips a hook whose event-type filter excludes the event's type", async () => {
    const db = await migratedDb();
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
    const db = await migratedDb();
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
});
