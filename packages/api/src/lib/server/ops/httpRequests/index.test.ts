import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { runPurge } from '#lib/server/jobs/purge.js';
import { asConfirmedRun, asRun, makeTestDb } from '#testing/testDb.js';
import { EXTERNAL, run } from '#testing/undoKit.js';

import { runOperation } from '../runner.js';
import { Conflict, type Actor } from '../types.js';

import '../audit/index.js';
import '../decisions/index.js';
import '../dids/index.js';
import '../users/index.js';
import './index.js';

// §10.1 step 7 "HTTP requests", §10.3 "HTTP requests": the node's own operations.

type RequestOut = {
  id: string;
  name: string;
  request: Record<string, unknown>;
  timeoutS: number;
  target: Record<string, unknown>;
  errorTarget: Record<string, unknown>;
};

const anna: Actor = { id: 'owner', name: 'Owner', role: 'user' };

async function arrange(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  return db;
}

function create(
  db: Db,
  input: Record<string, unknown> = {}
): Promise<RequestOut> {
  return run<RequestOut>(db, 'httpRequests.create', {
    name: 'crm',
    request: { url: 'https://crm.example/customers/{{callerNumber}}' },
    target: { kind: 'hangup' },
    errorTarget: EXTERNAL,
    ...input
  });
}

describe('HTTP requests of call flows (§10.3 "HTTP requests")', () => {
  it('creates one as a GET with a 5 s timeout unless given, and reads it back', async () => {
    const db = await arrange();
    const created = await create(db);
    expect(created).toMatchObject({
      name: 'crm',
      request: {
        method: 'GET',
        url: 'https://crm.example/customers/{{callerNumber}}',
        headers: [],
        body: null,
        contentType: null,
        secretSet: false
      },
      timeoutS: 5,
      target: { kind: 'hangup' },
      errorTarget: { kind: 'external' }
    });
    expect(await run(db, 'httpRequests.get', { id: created.id })).toEqual(
      created
    );
    const listed = await run<{ items: RequestOut[] }>(
      db,
      'httpRequests.list',
      {}
    );
    expect(listed.items.map(item => item.id)).toEqual([created.id]);
  });

  it('keeps its secret and secret header values encrypted, kept by a write that leaves them out', async () => {
    const db = await arrange();
    const created = await create(db, {
      request: {
        method: 'POST',
        url: 'https://crm.example/lookup',
        headers: [
          { name: 'Authorization', value: 'Bearer tok-123', secret: true }
        ],
        body: '{"caller":"{{callerNumber}}"}',
        contentType: 'application/json',
        secret: 'sign-me'
      },
      timeoutS: 2
    });
    expect(created.request).toMatchObject({
      headers: [{ name: 'Authorization', secret: true, secretSet: true }],
      secretSet: true
    });
    expect(JSON.stringify(created)).not.toContain('tok-123');
    expect(JSON.stringify(created)).not.toContain('sign-me');

    // The request as read goes back with its URL changed: the secrets stay.
    const before = await db
      .selectFrom('httpRequests')
      .select('secretEnc')
      .executeTakeFirstOrThrow();
    const updated = await run<RequestOut>(db, 'httpRequests.update', {
      id: created.id,
      request: { ...created.request, url: 'https://crm.example/v2/lookup' }
    });
    expect(updated.request).toMatchObject({
      url: 'https://crm.example/v2/lookup',
      secretSet: true
    });
    const after = await db
      .selectFrom('httpRequests')
      .select(['secretEnc', 'secretHeadersEnc'])
      .executeTakeFirstOrThrow();
    expect(after.secretEnc).toEqual(before.secretEnc);
    expect(after.secretHeadersEnc).not.toBeNull();
    // null removes the secret; neither write can be undone, a credential being involved.
    const unsigned = await run<RequestOut>(db, 'httpRequests.update', {
      id: created.id,
      request: { ...updated.request, secret: null }
    });
    expect(unsigned.request.secretSet).toBe(false);
    const audits = await db.selectFrom('auditLog').select('undoable').execute();
    expect(audits.map(entry => entry.undoable)).toEqual([0, 0, 0]);
  });

  it.each([
    [{ name: 'did' }, 'a placeholder as name'],
    [{ name: 'slice' }, 'a helper as name'],
    [{ name: 'cdr' }, 'the call record as name'],
    [{ name: 'my-crm' }, 'a name that is no identifier'],
    [{ name: '1crm' }, 'a name starting with a digit'],
    [{ timeoutS: 0 }, 'no timeout'],
    [{ timeoutS: 86_401 }, 'a timeout over a day'],
    [{ request: { url: 'http://203.0.113.7/x' } }, 'plain HTTP, public'],
    [{ request: { url: 'https://{{did}}/x' } }, 'a templated host'],
    [{ request: { url: 'https://crm.example/{{nope}}' } }, 'an unknown name'],
    [
      { request: { url: 'https://crm.example/x', body: 'a=1' } },
      'a body without its type'
    ],
    [
      {
        request: {
          url: 'https://crm.example/x',
          body: 'a=1',
          contentType: 'text/plain'
        }
      },
      'a body on the default GET'
    ]
  ] as [Record<string, unknown>, string][])('refuses %j: %s', async change => {
    const db = await arrange();
    await expect(create(db, change)).rejects.toMatchObject({ status: 422 });
  });

  it('lets templates read its answer by its name, and refuses a second request of that name', async () => {
    const db = await arrange();
    const crm = await create(db);
    await expect(create(db)).rejects.toMatchObject({ status: 409 });
    // A decision behind the request tests the answer; a target reads it too.
    const decision = await run<{ id: string }>(db, 'decisions.create', {
      name: 'Tier',
      cases: [
        {
          when: [
            { type: 'template', template: '{{crm.data.tier}}', equals: 'vip' }
          ],
          target: { kind: 'external', external: '+43{{crm.data.number}}' }
        }
      ],
      default: { kind: 'hangup' }
    });
    const routed = await run<RequestOut>(db, 'httpRequests.update', {
      id: crm.id,
      target: { kind: 'decision', decisionId: decision.id }
    });
    expect(routed.target).toMatchObject({ kind: 'decision' });
    // Another request may read this one's answer in its own URL.
    await expect(
      create(db, {
        name: 'tickets',
        request: { url: 'https://desk.example/t?c={{crm.data.id}}' }
      })
    ).resolves.toBeDefined();
  });

  it('is an admin target, read by a user as the marker, and blocks its delete while a target names it', async () => {
    const db = await arrange();
    const crm = await create(db);
    const target = { kind: 'httpRequest', httpRequestId: crm.id };
    const setForwarding = (value: unknown, actor?: Actor) =>
      runOperation(
        db,
        'users.setForwarding',
        { id: 'owner', rules: [{ condition: 'unconditional', target: value }] },
        asRun(actor === undefined ? {} : { actor })
      ) as Promise<{ rules: { target: unknown }[] }>;
    await expect(setForwarding(target, anna)).rejects.toMatchObject({
      status: 403,
      title: 'an httpRequest target is set by an admin'
    });
    await setForwarding(target);
    const marker = { managed: true, kind: 'httpRequest' };
    expect((await setForwarding(marker, anna)).rules).toEqual([
      { condition: 'unconditional', target: marker }
    ]);

    await expect(
      runOperation(db, 'httpRequests.delete', { id: crm.id }, asConfirmedRun())
    ).rejects.toBeInstanceOf(Conflict);
    await runOperation(
      db,
      'users.setForwarding',
      { id: 'owner', rules: [] },
      asRun()
    );
    await run(db, 'httpRequests.delete', { id: crm.id });
    await expect(
      run(db, 'httpRequests.get', { id: crm.id })
    ).rejects.toMatchObject({ status: 404 });
    // Its name is free again, and its own targets go with it at the purge.
    await create(db);
  });

  it('writes its target and its error target into the rows it holds (§11.2)', async () => {
    const db = await arrange();
    const created = await create(db);
    const held = async () =>
      db
        .selectFrom('httpRequests')
        .select(['targetId', 'errorTargetId'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
    const before = await held();
    const rows = await db.selectFrom('forwardTargets').select('id').execute();

    const updated = await run<RequestOut>(db, 'httpRequests.update', {
      id: created.id,
      target: EXTERNAL,
      errorTarget: { kind: 'hangup' }
    });
    expect(updated).toMatchObject({
      target: { kind: 'external' },
      errorTarget: { kind: 'hangup' }
    });
    expect(await held()).toEqual(before);
    expect(
      await db.selectFrom('forwardTargets').select('id').execute()
    ).toHaveLength(rows.length);
  });

  it('keeps its own targets through the purge, which removes only what nothing names', async () => {
    const db = await arrange();
    const crm = await create(db);
    await runPurge(db, new Date().toISOString());
    expect(await run(db, 'httpRequests.get', { id: crm.id })).toMatchObject({
      target: { kind: 'hangup' },
      errorTarget: { kind: 'external' }
    });
  });
});
