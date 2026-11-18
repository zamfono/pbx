import { describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';
import { run } from '#testing/undoKit.js';

import { runOperation } from './runner.js';
import type { Actor } from './types.js';

import './audit/index.js';
import './users/index.js';

// §10.6 "After-call requests", §10.3 "Forward targets": a target's after-call request on write.

const anna: Actor = { id: 'owner', name: 'Owner', role: 'user' };

type Stored = { rules: { target: Record<string, unknown> }[] };

async function arrange() {
  const db = await makeTestDb();
  await seedSettings(db);
  const setForwarding = (target: Record<string, unknown>, actor?: Actor) =>
    runOperation(
      db,
      'users.setForwarding',
      { id: 'owner', rules: [{ condition: 'unconditional', target }] },
      asRun(actor === undefined ? {} : { actor })
    ) as Promise<Stored>;
  const withAfterCall = (afterCall: unknown, actor?: Actor) =>
    setForwarding(
      { kind: 'external', external: '+4366412345', afterCall },
      actor
    );
  return { db, setForwarding, withAfterCall };
}

const REQUEST = {
  url: 'https://crm.example/calls/{{callId}}',
  secret: 'sign-me',
  headers: [
    { name: 'Authorization', value: 'Bearer tok-123', secret: true },
    { name: 'X-Caller', value: '{{callerNumber}}' }
  ],
  recordings: ['download', 'delete']
};

describe('an after-call request on a forward target', () => {
  it('is stored with its secrets encrypted and read back without them', async () => {
    const { db, withAfterCall } = await arrange();
    const stored = await withAfterCall(REQUEST);
    const afterCall = stored.rules[0]?.target.afterCall as Record<
      string,
      unknown
    >;
    expect(afterCall).toMatchObject({
      method: 'POST',
      url: REQUEST.url,
      headers: [
        { name: 'Authorization', secret: true, secretSet: true },
        { name: 'X-Caller', value: '{{callerNumber}}', secret: false }
      ],
      body: null,
      contentType: null,
      secretSet: true,
      recordings: ['download', 'delete'],
      lastStatus: null,
      failedDeliveries: 0
    });
    expect(afterCall.secret).toBeUndefined();
    const row = await db
      .selectFrom('afterCallRequests')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(afterCall.id).toBeUndefined();
    const raw = JSON.stringify({
      ...row,
      secretEnc: row.secretEnc.toString('utf8'),
      secretHeadersEnc: row.secretHeadersEnc?.toString('utf8')
    });
    expect(raw).not.toContain('tok-123');
    expect(raw).not.toContain('sign-me');
    // A credential was written: the entry cannot be undone (§5.8).
    const audit = await db
      .selectFrom('auditLog')
      .select(['undoable', 'changesJson'])
      .orderBy('createdAt', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(0);
    expect(audit.changesJson).toContain('crm.example');
    expect(audit.changesJson).not.toContain('tok-123');
    expect(audit.changesJson).not.toContain('sign-me');
  });

  it('keeps its row through a write-back of the target as read: its id, secrets and delivery health', async () => {
    const { db, setForwarding, withAfterCall } = await arrange();
    const first = (await withAfterCall(REQUEST)).rules[0]?.target ?? {};
    await db
      .updateTable('afterCallRequests')
      .set({
        lastStatus: 'failing',
        lastDeliveryAt: '2026-11-18T10:05:00.000Z',
        failingSince: '2026-11-18T10:00:00.000Z',
        failedDeliveries: 3,
        lastError: 'HTTP 500',
        lastErrorAt: '2026-11-18T10:05:00.000Z'
      })
      .execute();
    const before = await db
      .selectFrom('afterCallRequests')
      .selectAll()
      .executeTakeFirstOrThrow();

    // What was read goes back with one field of the target and one of the request changed.
    const again = await setForwarding({
      ...first,
      ringTimeoutS: 20,
      afterCall: { ...(first.afterCall as object), recordings: ['download'] }
    });
    const health = {
      lastStatus: 'failing',
      lastDeliveryAt: '2026-11-18T10:05:00.000Z',
      failingSince: '2026-11-18T10:00:00.000Z',
      failedDeliveries: 3,
      lastError: 'HTTP 500',
      lastErrorAt: '2026-11-18T10:05:00.000Z'
    };
    expect(again.rules[0]?.target.afterCall).toMatchObject({
      ...health,
      recordings: ['download']
    });
    const rows = await db.selectFrom('afterCallRequests').selectAll().execute();
    // The same row: its id and signing secret as stored, the secret header's value encrypted
    // anew.
    expect(rows).toEqual([
      {
        ...before,
        recordingDelete: 0,
        secretHeadersEnc: rows[0]?.secretHeadersEnc
      }
    ]);
    expect(rows[0]).toMatchObject(health);
    expect(rows[0]?.secretHeadersEnc).not.toBeNull();
  });

  it('can be undone when a write leaves its secrets as they are, not when it sets or drops one', async () => {
    const { db, setForwarding, withAfterCall } = await arrange();
    const first = (await withAfterCall(REQUEST)).rules[0]?.target ?? {};
    const stored = await db
      .selectFrom('afterCallRequests')
      .selectAll()
      .executeTakeFirstOrThrow();
    const latest = () =>
      db
        .selectFrom('auditLog')
        .select(['id', 'undoable'])
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

    // A write-back with the request's URL changed: undoable, and the undo restores the URL in
    // the same row, its secrets as stored.
    await setForwarding({
      ...first,
      afterCall: {
        ...(first.afterCall as object),
        url: 'https://crm.example/v2'
      }
    });
    const entry = await latest();
    expect(entry.undoable).toBe(1);
    await run(db, 'audit.undo', { id: entry.id });
    const undone = await db
      .selectFrom('afterCallRequests')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(undone).toMatchObject({
      id: stored.id,
      url: REQUEST.url,
      secretEnc: stored.secretEnc
    });

    // A new signing secret, a secret header's new value, a secret header left out or made
    // plain: none can be undone.
    const afterCall = first.afterCall as Record<string, unknown>;
    for (const change of [
      { secret: 'new-secret' },
      {
        headers: [
          { name: 'Authorization', value: 'Bearer new', secret: true },
          REQUEST.headers[1]
        ]
      },
      { headers: [REQUEST.headers[1]] },
      {
        headers: [
          { name: 'Authorization', value: 'Bearer plain', secret: false },
          REQUEST.headers[1]
        ]
      }
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each write builds on the one before
      await setForwarding({ ...first, afterCall: { ...afterCall, ...change } });
      // eslint-disable-next-line no-await-in-loop -- reads the entry the write just made
      expect((await latest()).undoable).toBe(0);
      // eslint-disable-next-line no-await-in-loop -- restores the secret header for the next
      await withAfterCall(REQUEST);
    }
  });

  it('is deleted by a write of its target without it, which cannot be undone', async () => {
    const { db, setForwarding, withAfterCall } = await arrange();
    await withAfterCall(REQUEST);
    const target = await db
      .selectFrom('userForwardRules')
      .select('targetId')
      .executeTakeFirstOrThrow();
    await withAfterCall(null);
    expect(
      await db.selectFrom('afterCallRequests').selectAll().execute()
    ).toEqual([]);
    const audit = await db
      .selectFrom('auditLog')
      .select('undoable')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(0);

    // A kind that takes none deletes it too, the target's row staying the same one.
    await withAfterCall(REQUEST);
    await setForwarding({ kind: 'mailboxUser', userId: 'owner' });
    expect(
      await db.selectFrom('afterCallRequests').selectAll().execute()
    ).toEqual([]);
    expect(
      await db.selectFrom('userForwardRules').select('targetId').execute()
    ).toEqual([target]);
  });

  it('goes with its target when the rule is removed', async () => {
    const { db, withAfterCall } = await arrange();
    await withAfterCall(REQUEST);
    await runOperation(
      db,
      'users.setForwarding',
      { id: 'owner', rules: [] },
      asRun()
    );
    expect(
      await db.selectFrom('afterCallRequests').selectAll().execute()
    ).toEqual([]);
  });

  it('refuses one with no secret to keep: a new target, a target that has none, and the id a read no longer returns', async () => {
    const { db, withAfterCall } = await arrange();
    const unsigned = { url: REQUEST.url, headers: REQUEST.headers };
    await expect(withAfterCall(unsigned)).rejects.toMatchObject({
      status: 422,
      title: 'afterCall has no stored secret to keep; give its secret'
    });
    await expect(
      withAfterCall({ ...REQUEST, id: 'nope' })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      withAfterCall({
        ...REQUEST,
        headers: [{ name: 'Authorization', secret: true }]
      })
    ).rejects.toMatchObject({ status: 422 });
    // Another condition's target is another target: what was read of the first keeps nothing
    // there.
    const first = (await withAfterCall(REQUEST)).rules[0]?.target ?? {};
    const twice = runOperation(
      db,
      'users.setForwarding',
      {
        id: 'owner',
        rules: [
          { condition: 'unconditional', target: first },
          { condition: 'busy', target: first }
        ]
      },
      asRun()
    );
    await expect(twice).rejects.toMatchObject({ status: 422 });
    expect(
      await db.selectFrom('afterCallRequests').selectAll().execute()
    ).toHaveLength(1);
  });

  it.each([
    [{ url: 'ftp://crm.example/x' }, 'no http(s) URL'],
    [{ url: 'https://{{did}}.example/x' }, 'a placeholder in the host'],
    [{ url: 'http://203.0.113.7/x' }, 'plain HTTP to a public address'],
    [{ url: 'http://127.0.0.1/x' }, 'loopback'],
    [{ url: 'https://crm.example/{{nope}}' }, 'an unknown placeholder'],
    [{ body: '{"a":1}' }, 'a body without its content type'],
    [{ contentType: 'application/json' }, 'a content type without a body'],
    [
      { method: 'GET', body: 'a=1', contentType: 'text/plain' },
      'a body on a GET'
    ],
    [
      { body: '{{#each cdr.recordings}}x{{/each}}', contentType: 'text/plain' },
      'a block in the body'
    ],
    [{ headers: [{ name: 'Host', value: 'x' }] }, 'a reserved header'],
    [{ headers: [{ name: 'X-A', value: '{{nope}}' }] }, 'an unknown name'],
    [{ recordings: ['share'] }, 'an unknown recording scope'],
    [{ lastStatus: 'broken' }, 'a status that is none']
  ] as [Record<string, unknown>, string][])('refuses %j: %s', async change => {
    const { withAfterCall } = await arrange();
    await expect(
      withAfterCall({ ...REQUEST, ...change })
    ).rejects.toMatchObject({ status: 422 });
  });

  it("takes a body template reading the call's record, and plain HTTP to a private address", async () => {
    const { withAfterCall } = await arrange();
    const stored = await withAfterCall({
      ...REQUEST,
      method: 'PUT',
      url: 'http://10.0.0.5:8080/calls',
      body: '{"from":"{{cdr.fromUri}}","url":"{{cdr.recordings.0.downloadUrl}}","tier":"{{slice did -2}}"}',
      contentType: 'application/json'
    });
    expect(stored.rules[0]?.target.afterCall).toMatchObject({
      method: 'PUT',
      contentType: 'application/json'
    });
  });

  it('is an admin target: refused from a user with 403, and read by them as the marker', async () => {
    const { withAfterCall, setForwarding } = await arrange();
    await expect(withAfterCall(REQUEST, anna)).rejects.toMatchObject({
      status: 403,
      title: 'an after-call request is set by an admin'
    });
    await withAfterCall(REQUEST);
    const marker = { managed: true, kind: 'external' };
    expect((await setForwarding(marker, anna)).rules).toEqual([
      { condition: 'unconditional', target: marker }
    ]);
  });
});
