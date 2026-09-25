import { describe, expect, it } from 'vitest';

import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';
import type { WebhookWire } from './_shared.js';

import './index.js';

// webhooks.create/update encrypt `secret` via secretbox (§5.4), which needs a key.
process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

describe('webhooks', () => {
  it('creates a webhook inactive, never returning the secret', async () => {
    const db = await makeTestDb();
    const created = await runOperation<
      unknown,
      WebhookWire & { secret?: unknown }
    >(
      db,
      'webhooks.create',
      { url: 'https://example.invalid/hook', secret: 'sh-secret' },
      asRun()
    );
    expect(created.active).toBe(false);
    expect(created.secret).toBeUndefined();
    const row = await db
      .selectFrom('webhooks')
      .select('secretEnc')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.secretEnc.toString('utf8')).not.toContain('sh-secret');
  });

  it('lists, activates and deletes a webhook', async () => {
    const db = await makeTestDb();
    const created = await runOperation<unknown, WebhookWire>(
      db,
      'webhooks.create',
      { url: 'https://example.invalid/hook', secret: 'sh-secret' },
      asRun()
    );
    const listed = await runOperation<unknown, { items: WebhookWire[] }>(
      db,
      'webhooks.list',
      {},
      asRun()
    );
    expect(listed.items.map(item => item.id)).toContain(created.id);
    const updated = await runOperation<unknown, WebhookWire>(
      db,
      'webhooks.update',
      { id: created.id, active: true, eventTypes: ['voicemail.new'] },
      asRun()
    );
    expect(updated.active).toBe(true);
    expect(updated.eventTypes).toEqual(['voicemail.new']);
    await runOperation(
      db,
      'webhooks.delete',
      { id: created.id },
      asRun({ confirm: true })
    );
    const afterDelete = await runOperation<unknown, { items: WebhookWire[] }>(
      db,
      'webhooks.list',
      {},
      asRun()
    );
    expect(afterDelete.items.map(item => item.id)).not.toContain(created.id);
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
});
