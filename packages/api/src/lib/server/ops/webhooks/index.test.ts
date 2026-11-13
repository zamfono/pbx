import { describe, expect, it } from 'vitest';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { WebhookWire } from './_shared.js';

import './index.js';

describe('webhooks', () => {
  it('creates a webhook inactive, never returning the secret', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'webhooks.create',
      { url: 'https://example.invalid/hook', secret: 'sh-secret' },
      asRun()
    )) as WebhookWire & { secret?: unknown };
    expect(created.active).toBe(false);
    expect(created.secret).toBeUndefined();
    expect(created.secretSet).toBe(true);
    await expect(
      runOperation(
        db,
        'webhooks.update',
        { id: created.id, secret: null },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    const row = await db
      .selectFrom('webhooks')
      .select('secretEnc')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.secretEnc.toString('utf8')).not.toContain('sh-secret');
  });

  it('lists, activates and deletes a webhook', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'webhooks.create',
      { url: 'https://example.invalid/hook', secret: 'sh-secret' },
      asRun()
    )) as WebhookWire;
    const listed = (await runOperation(db, 'webhooks.list', {}, asRun())) as {
      items: WebhookWire[];
    };
    expect(listed.items.map(item => item.id)).toContain(created.id);
    const updated = (await runOperation(
      db,
      'webhooks.update',
      { id: created.id, active: true, eventTypes: ['voicemail.new'] },
      asRun()
    )) as WebhookWire;
    expect(updated.active).toBe(true);
    expect(updated.eventTypes).toEqual(['voicemail.new']);
    await runOperation(
      db,
      'webhooks.delete',
      { id: created.id },
      asRun({ confirm: true })
    );
    const afterDelete = (await runOperation(
      db,
      'webhooks.list',
      {},
      asRun()
    )) as { items: WebhookWire[] };
    expect(afterDelete.items.map(item => item.id)).not.toContain(created.id);
  });

  it.each([
    ['deleted', 'webhooks.delete', {}],
    ['switched off', 'webhooks.update', { active: false }]
  ])("drops a %s webhook's pending deliveries", async (_case, name, change) => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'webhooks.create',
      { url: 'https://example.invalid/hook', secret: 'sh-secret' },
      asRun()
    )) as WebhookWire;
    await db
      .insertInto('webhookDeliveries')
      .values({
        id: 'delivery-1',
        webhookId: created.id,
        bodyJson: '{}',
        attempts: 1,
        nextAttemptAt: '2026-10-01T10:00:01.000Z',
        createdAt: '2026-10-01T10:00:00.000Z'
      })
      .execute();

    await runOperation(
      db,
      name,
      { id: created.id, ...change },
      asRun({ confirm: true })
    );

    const pending = await db
      .selectFrom('webhookDeliveries')
      .select('id')
      .execute();
    expect(pending).toEqual([]);
  });

  it('brings back no dropped delivery when a hook is switched on again', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'webhooks.create',
      { url: 'https://example.invalid/hook', secret: 'sh-secret' },
      asRun()
    )) as WebhookWire;
    await runOperation(
      db,
      'webhooks.update',
      { id: created.id, active: true },
      asRun()
    );
    await db
      .insertInto('webhookDeliveries')
      .values({
        id: 'delivery-1',
        webhookId: created.id,
        bodyJson: '{}',
        attempts: 1,
        nextAttemptAt: '2026-10-01T10:00:01.000Z',
        createdAt: '2026-10-01T10:00:00.000Z'
      })
      .execute();

    for (const active of [false, true]) {
      // eslint-disable-next-line no-await-in-loop -- off, then on again, in that order
      await runOperation(
        db,
        'webhooks.update',
        { id: created.id, active },
        asRun()
      );
    }

    const pending = await db
      .selectFrom('webhookDeliveries')
      .select('id')
      .execute();
    expect(pending).toEqual([]);
  });

  it("lists a failing hook's failures since it turned failing and its last error", async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'webhooks.create',
      { url: 'https://example.invalid/hook', secret: 'sh-secret' },
      asRun()
    )) as WebhookWire;
    expect(created).toMatchObject({
      failingSince: null,
      failedDeliveries: 0,
      lastError: null,
      lastErrorAt: null
    });
    await db
      .updateTable('webhooks')
      .set({
        lastStatus: 'failing',
        lastDeliveryAt: '2026-10-01T10:05:00.000Z',
        failingSince: '2026-10-01T09:00:00.000Z',
        failedDeliveries: 4,
        lastError: 'HTTP 403',
        lastErrorAt: '2026-10-01T10:05:00.000Z'
      })
      .execute();

    const listed = (await runOperation(db, 'webhooks.list', {}, asRun())) as {
      items: WebhookWire[];
    };

    expect(listed.items).toMatchObject([
      {
        id: created.id,
        lastStatus: 'failing',
        failingSince: '2026-10-01T09:00:00.000Z',
        failedDeliveries: 4,
        lastError: 'HTTP 403',
        lastErrorAt: '2026-10-01T10:05:00.000Z'
      }
    ]);
  });

  it('refuses a non-HTTP webhook URL', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'webhooks.create',
        { url: 'file:///etc/passwd', secret: 'sh-secret' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  // §3.1 "Outbound targets": an address literal no delivery could reach is refused at once; a
  // private one is the delivery's to check against ALLOW_PRIVATE_TARGETS.
  it.each([
    'http://127.0.0.1:3000/internal/mail',
    'http://[::1]/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/hook',
    'http://0.0.0.0/hook'
  ])('refuses %s', async url => {
    const db = await makeTestDb();
    await expect(
      runOperation(db, 'webhooks.create', { url, secret: 's' }, asRun())
    ).rejects.toMatchObject({ status: 422 });
  });

  it.each(['http://192.168.1.20/hook', 'http://core:3000/x'])(
    'takes %s, a private address or a name, which the delivery checks',
    async url => {
      const db = await makeTestDb();
      await expect(
        runOperation(db, 'webhooks.create', { url, secret: 's' }, asRun())
      ).resolves.toBeDefined();
    }
  );
});
