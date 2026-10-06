import { describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { MailTemplateWire } from './_shared.js';

import './index.js';

describe('mailTemplates', () => {
  it('lists the seven builtin templates in the tenant language', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const listed = (await runOperation(
      db,
      'mailTemplates.list',
      {},
      asRun()
    )) as { items: MailTemplateWire[] };
    expect(listed.items).toHaveLength(7);
    expect(listed.items.every(item => item.source === 'builtin')).toBe(true);
  });

  it('pages the list like every other list (§10.3 "Conventions")', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    type Page = { items: MailTemplateWire[]; nextCursor: string | null };
    const first = (await runOperation(
      db,
      'mailTemplates.list',
      { limit: 4 },
      asRun()
    )) as Page;
    expect(first.items).toHaveLength(4);
    const second = (await runOperation(
      db,
      'mailTemplates.list',
      { limit: 4, cursor: first.nextCursor },
      asRun()
    )) as Page;
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items).toHaveLength(3);
  });

  it('refuses a template naming a placeholder its kind does not offer', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
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
    await seedSettings(db);
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
    const read = (await runOperation(
      db,
      'mailTemplates.get',
      { kind: 'reset', language: 'en' },
      asRun()
    )) as MailTemplateWire;
    expect(read.source).toBe('tenant');
    expect(read.subject).toBe('Reset your password');
    await runOperation(
      db,
      'mailTemplates.delete',
      { kind: 'reset', language: 'en' },
      asRun({ confirm: true })
    );
    const afterDelete = (await runOperation(
      db,
      'mailTemplates.get',
      { kind: 'reset', language: 'en' },
      asRun()
    )) as MailTemplateWire;
    expect(afterDelete.source).toBe('builtin');
  });

  it('skips a test send while no relay is configured, auditing it as non-undoable', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const result = (await runOperation(
      db,
      'mailTemplates.test',
      { kind: 'reset' },
      asRun()
    )) as { status: string };
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
