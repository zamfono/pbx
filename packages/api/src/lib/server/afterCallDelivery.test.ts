import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  nowIso,
  type AfterCallReport,
  type Db,
  type HttpHeaderInput,
  type TargetAttempt
} from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { testKeyring } from '#testing/fixtures.js';

import {
  authenticateRecordingLink,
  recordingLinks
} from './auth/recordingLinks.js';
import { AFTER_CALL_PURPOSES } from './ops/afterCall.js';
import { storeBlock } from './ops/httpRequestBlock.js';

import './ops/recordings/index.js';

import { handleRest } from './rest.js';
import { encrypt } from './secretbox.js';
import { WebhookDispatcher } from './webhooks.js';

// §10.6 "After-call requests": the request a forward target sends after each of its attempts.

const JWT_SECRET = 'test-jwt-secret-of-at-least-32-bytes!!';
const ORIGIN = 'https://pbx.example.com';
// One keyring for the rows and the dispatcher that reads them.
const KEYRING = testKeyring();

type Received = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function startReceiver(): Promise<{
  url: string;
  requests: Received[];
  answer: { status: number };
  close: () => Promise<void>;
}> {
  const requests: Received[] = [];
  const answer = { status: 200 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      res.writeHead(answer.status).end();
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    answer,
    close: () =>
      new Promise(resolve => {
        server.close(() => {
          resolve();
        });
      })
  };
}

const ATTEMPT: TargetAttempt = {
  forwardTargetId: 'ft1',
  kind: 'external',
  external: '+4366412345',
  outcome: 'answered',
  cause: null,
  startedAt: '2026-11-18T10:00:01.000Z',
  endedAt: '2026-11-18T10:00:09.000Z',
  values: { callerNumber: '+43 660 "1"', did: '+4315550117', callId: 'call1' }
};
const REPORT: AfterCallReport = { callId: 'call1', attempts: [ATTEMPT] };

/** A finished call with one recording, forwarded to target `ft1`, whose after-call request is
 * `request` on top of a POST to `url`. */
async function seed(
  db: Db,
  url: string,
  request: {
    method?: 'POST' | 'PUT' | 'GET';
    path?: string;
    headers?: HttpHeaderInput[];
    body?: string;
    contentType?: 'application/json' | 'application/x-www-form-urlencoded';
    recordings?: ('download' | 'delete')[];
  } = {}
): Promise<void> {
  const kr = KEYRING;
  await db
    .insertInto('calls')
    .values({
      id: 'call1',
      direction: 'inbound',
      fromUri: '+436601',
      toUri: '+4315550117',
      status: 'answered',
      startedAt: '2026-11-18T10:00:00.000Z',
      answeredAt: '2026-11-18T10:00:09.000Z',
      endedAt: '2026-11-18T10:01:00.000Z',
      log: '{"event":"secret-header"}'
    })
    .execute();
  await db
    .insertInto('recordings')
    .values({
      id: 'rec1',
      callId: 'call1',
      userId: null,
      filename: 'rec1.wav',
      durationS: 51,
      createdAt: '2026-11-18T10:01:01.000Z'
    })
    .execute();
  await db
    .insertInto('forwardTargets')
    .values({ id: 'ft1', external: '+4366412345' })
    .execute();
  const recordings = request.recordings ?? [];
  await db
    .insertInto('afterCallRequests')
    .values({
      id: 'acr1',
      forwardTargetId: 'ft1',
      ...storeBlock(kr, AFTER_CALL_PURPOSES, {
        method: request.method ?? 'POST',
        url: `${url}${request.path ?? '/calls'}`,
        headers: request.headers ?? [],
        body: request.body ?? null,
        contentType: request.contentType ?? null
      }),
      secretEnc: encrypt(kr, AFTER_CALL_PURPOSES.secret, 'sign-me'),
      recordingDownload: recordings.includes('download') ? 1 : 0,
      recordingDelete: recordings.includes('delete') ? 1 : 0
    })
    .execute();
}

function dispatcherFor(db: Db): WebhookDispatcher {
  return new WebhookDispatcher({
    db,
    kr: KEYRING,
    targetPolicy: null,
    delay: () => Promise.resolve(),
    links: () => ({ jwtSecret: JWT_SECRET, origin: ORIGIN })
  });
}

describe('after-call request delivery', () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let db: Db;

  beforeEach(async () => {
    receiver = await startReceiver();
    db = await migratedTestDb();
  });

  afterEach(async () => {
    await receiver.close();
    await db.destroy();
  });

  it('POSTs the call record, signed, with rendered headers and a fresh link per recording', async () => {
    await seed(db, receiver.url, {
      path: '/calls/{{callId}}?did={{did}}',
      headers: [
        { name: 'Authorization', value: 'Bearer tok-123', secret: true },
        { name: 'X-Caller', value: ' {{callerNumber}} ', secret: false },
        { name: 'X-Empty', value: '{{calledName}}', secret: false }
      ],
      recordings: ['download', 'delete']
    });

    await dispatcherFor(db).enqueueAfterCall(REPORT);

    const [request] = receiver.requests;
    expect(request).toMatchObject({
      method: 'POST',
      url: '/calls/call1?did=%2B4315550117',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-123',
        'x-caller': '+43 660 "1"'
      }
    });
    expect(request?.headers['x-empty']).toBeUndefined();
    expect(request?.headers['x-zamfono-signature']).toBe(
      createHmac('sha256', 'sign-me')
        .update(request?.body ?? '')
        .digest('hex')
    );
    const record = JSON.parse(request?.body ?? '') as {
      recordings: { downloadUrl: string; deleteUrl: string }[];
    };
    // The call as GET /calls/{id} returns it, without its log.
    expect(record).toMatchObject({
      id: 'call1',
      direction: 'inbound',
      fromUri: '+436601',
      status: 'answered',
      qos: [],
      childCallIds: [],
      recordings: [{ id: 'rec1', userId: null, durationS: 51 }],
      target: {
        forwardTargetId: 'ft1',
        kind: 'external',
        external: '+4366412345',
        outcome: 'answered',
        cause: null
      }
    });
    expect(record).not.toHaveProperty('log');
    expect(record).not.toHaveProperty('target.values');
    const [recording] = record.recordings;
    expect(recording?.downloadUrl).toMatch(
      /^https:\/\/pbx\.example\.com\/api\/v1\/recordings\/rec1\/audio\?access_token=/u
    );
    expect(recording?.deleteUrl).toMatch(
      /^https:\/\/pbx\.example\.com\/api\/v1\/recordings\/rec1\?access_token=[^&]+$/u
    );
    // Nothing of the token was ever in the outbox, which is empty again; the request is `ok`.
    expect(
      await db.selectFrom('webhookDeliveries').selectAll().execute()
    ).toEqual([]);
    expect(
      await db
        .selectFrom('afterCallRequests')
        .select(['lastStatus', 'failedDeliveries'])
        .executeTakeFirstOrThrow()
    ).toEqual({ lastStatus: 'ok', failedDeliveries: 0 });
  });

  it("renders a body template with the record's fields, escaped for its content type", async () => {
    await seed(db, receiver.url, {
      method: 'PUT',
      body: '{"caller":"{{callerNumber}}","to":"{{cdr.toUri}}","outcome":"{{cdr.target.outcome}}","rec":"{{cdr.recordings.0.id}}","none":"{{cdr.recordings.1.id}}"}',
      contentType: 'application/json'
    });

    await dispatcherFor(db).enqueueAfterCall(REPORT);

    const [request] = receiver.requests;
    expect(request?.method).toBe('PUT');
    expect(JSON.parse(request?.body ?? '')).toEqual({
      caller: '+43 660 "1"',
      to: '+4315550117',
      outcome: 'answered',
      rec: 'rec1',
      none: ''
    });
  });

  it('retries three times, then marks the request failing with the reason', async () => {
    receiver.answer.status = 503;
    await seed(db, receiver.url);

    await dispatcherFor(db).enqueueAfterCall(REPORT);

    expect(receiver.requests).toHaveLength(3);
    expect(
      await db
        .selectFrom('afterCallRequests')
        .select(['lastStatus', 'lastError', 'failedDeliveries'])
        .executeTakeFirstOrThrow()
    ).toEqual({
      lastStatus: 'failing',
      lastError: 'HTTP 503',
      failedDeliveries: 1
    });
  });

  it('sends nothing for a target without a request, and drops a delivery whose request lost its target', async () => {
    await seed(db, receiver.url);
    const dispatcher = dispatcherFor(db);
    await dispatcher.enqueueAfterCall({
      callId: 'call1',
      attempts: [{ ...ATTEMPT, forwardTargetId: 'other' }]
    });
    await db
      .insertInto('webhookDeliveries')
      .values({
        id: 'd1',
        afterCallRequestId: 'acr1',
        bodyJson: JSON.stringify({ callId: 'call1', attempt: ATTEMPT }),
        nextAttemptAt: nowIso(),
        createdAt: nowIso()
      })
      .execute();
    await db.deleteFrom('forwardTargets').where('id', '=', 'ft1').execute();

    await dispatcher.resume();

    expect(receiver.requests).toEqual([]);
    expect(
      await db.selectFrom('webhookDeliveries').selectAll().execute()
    ).toEqual([]);
  });
});

describe('recording links', () => {
  const deps = { jwtSecret: JWT_SECRET, origin: ORIGIN };
  const recording = { id: 'rec1', forwardTargetId: 'ft1' };
  const auth = (method: string, url: string | undefined) =>
    authenticateRecordingLink(JWT_SECRET, {
      method,
      url: new URL(url ?? 'https://pbx.example.com/')
    });

  it('opens the one recording for what its scope names, as the after-call request', async () => {
    const links = await recordingLinks(
      deps,
      recording,
      ['download', 'delete'],
      Date.now()
    );
    const actor = {
      id: 'ft1',
      name: 'after-call request of forward target ft1',
      role: 'admin',
      recordingLink: true
    };
    expect(await auth('GET', links.downloadUrl)).toEqual({ actor });
    expect(await auth('DELETE', links.deleteUrl)).toEqual({ actor });
    // Neither link does the other's work, opens another recording or another path.
    expect(await auth('DELETE', links.downloadUrl)).toBeNull();
    expect(await auth('GET', links.deleteUrl)).toBeNull();
    expect(
      await auth('GET', links.downloadUrl?.replace('rec1', 'rec2'))
    ).toBeNull();
    expect(
      await auth(
        'GET',
        links.downloadUrl?.replace('/recordings/rec1/audio', '/users')
      )
    ).toBeNull();
  });

  it('gives only the links asked for, and none that outlives its hour', async () => {
    expect(await recordingLinks(deps, recording, [], Date.now())).toEqual({});
    const downloadOnly = await recordingLinks(
      deps,
      recording,
      ['download'],
      Date.now()
    );
    expect(downloadOnly.deleteUrl).toBeUndefined();
    const deleteUrl = downloadOnly.downloadUrl?.replace('/audio', '');
    expect(await auth('DELETE', deleteUrl)).toBeNull();
    const old = await recordingLinks(
      deps,
      recording,
      ['download'],
      Date.now() - 3_601_000
    );
    expect(await auth('GET', old.downloadUrl)).toBeNull();
  });

  it('deletes the recording through the REST endpoint at once, audited as the after-call request', async () => {
    const db = await migratedTestDb();
    await seed(db, 'http://127.0.0.1:1');
    const links = await recordingLinks(deps, recording, ['delete'], Date.now());
    const url = new URL((links.deleteUrl ?? '').replace(ORIGIN, 'http://api'));
    const authenticated = await authenticateRecordingLink(JWT_SECRET, {
      method: 'DELETE',
      url
    });

    const response = await handleRest(
      new Request(url, { method: 'DELETE' }),
      authenticated?.actor ?? null,
      { db, requestId: 'req-1' }
    );

    expect(response.status).toBe(200);
    expect(await db.selectFrom('recordings').select('id').execute()).toEqual(
      []
    );
    expect(
      await db
        .selectFrom('auditLog')
        .select(['actorUserId', 'actorUserName', 'operation', 'undoable'])
        .execute()
    ).toEqual([
      {
        actorUserId: 'ft1',
        actorUserName: 'after-call request of forward target ft1',
        operation: 'recordings.delete',
        undoable: 0
      }
    ]);
    await db.destroy();
  });
});
