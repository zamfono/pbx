import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';
import type { MailTemplateWire } from './_shared.js';

import './index.js';

// mailTemplates.test sends via secretbox-protected relay settings (§5.4), which needs a key.
process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton, required by `mailTemplates.test` (§11.4 `mainDidId`). */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+491234567',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const mainDidId = newId();
  await db
    .insertInto('dids')
    .values({
      id: mainDidId,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId
    })
    .execute();
}

describe('mailTemplates', () => {
  it('lists the six builtin templates in the tenant language', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const listed = await runOperation<unknown, { items: MailTemplateWire[] }>(
      db,
      'mailTemplates.list',
      {},
      asRun()
    );
    expect(listed.items).toHaveLength(6);
    expect(listed.items.every(item => item.source === 'builtin')).toBe(true);
  });

  it('refuses a template naming a placeholder its kind does not offer', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await expect(
      runOperation(
        db,
        'mailTemplates.put',
        {
          kind: 'reset',
          language: 'en',
          subject: 'Reset',
          bodyText: 'Hello {{link}}, your extension is {{notAPlaceholder}}',
          bodyHtml: null
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('puts a tenant override, reads it back marked tenant, then deletes it', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await runOperation(
      db,
      'mailTemplates.put',
      {
        kind: 'reset',
        language: 'en',
        subject: 'Reset your password',
        bodyText: 'Use {{link}}, {{recipientName}}.',
        bodyHtml: null
      },
      asRun()
    );
    const read = await runOperation<unknown, MailTemplateWire>(
      db,
      'mailTemplates.get',
      { kind: 'reset', language: 'en' },
      asRun()
    );
    expect(read.source).toBe('tenant');
    expect(read.subject).toBe('Reset your password');
    await runOperation(
      db,
      'mailTemplates.delete',
      { kind: 'reset', language: 'en' },
      asRun({ confirm: true })
    );
    const afterDelete = await runOperation<unknown, MailTemplateWire>(
      db,
      'mailTemplates.get',
      { kind: 'reset', language: 'en' },
      asRun()
    );
    expect(afterDelete.source).toBe('builtin');
  });

  it('skips a test send while no relay is configured, auditing it as non-undoable', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const result = await runOperation<unknown, { status: string }>(
      db,
      'mailTemplates.test',
      { kind: 'reset' },
      asRun()
    );
    expect(result.status).toBe('skipped');
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'mailTemplates.test')
      .executeTakeFirstOrThrow();
    expect(audit.entityKind).toBe('mailTemplate');
    expect(audit.entityId).toBe('reset:en');
    expect(audit.undoable).toBe(0);
  });
});
