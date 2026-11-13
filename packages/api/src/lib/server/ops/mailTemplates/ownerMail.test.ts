import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db, MailKind } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import { noticeMfaChange } from '#lib/server/auth/mfa/notice.js';
import { requestPasswordReset } from '#lib/server/auth/passwordReset.js';
import { mailOwners, updateMailSender } from '#lib/server/mail/owners.js';
import { testKeyring } from '#testing/fixtures.js';
import { asConfirmedRun, asRun, makeTestDb, owner } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import '../audit/index.js';
import '../users/index.js';
import './index.js';

// Every mail reaches this list instead of a relay: who it went to and what it said.
const sent = vi.hoisted(
  (): { to: unknown; subject: string; text: string }[] => []
);
vi.mock('#lib/server/mail/relay.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#lib/server/mail/relay.js')>()),
  createTransportFor: () => ({
    sendMail: (message: { to: unknown; subject: string; text: string }) => {
      sent.push(message);
      return Promise.resolve({});
    }
  })
}));

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };
const FOREIGN = 'https://evil.example/c?u=';

/** The seeded owner, `admin`, a configured relay and the admin's setup and reset overrides,
 *  each sending the link through a foreign host. */
async function withAdminOverrides(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db, {
    companyName: 'Acme',
    smtpHost: 'smtp.example.test',
    mailFrom: 'pbx@example.test'
  });
  await seedUser(db, {
    id: admin.id,
    name: admin.name,
    email: 'admin@x.test',
    role: 'admin',
    passwordHash: 'x'
  });
  // An address the forgot-password form accepts.
  await db
    .updateTable('users')
    .set({ email: 'owner@x.test' })
    .where('id', '=', owner.id)
    .execute();
  for (const kind of ['setup', 'reset'] as const) {
    // eslint-disable-next-line no-await-in-loop -- two writes, in turn
    await runOperation(
      db,
      'mailTemplates.put',
      {
        kind,
        language: 'en',
        subject: 'Action needed',
        bodyText: `Confirm at ${FOREIGN}{{link}}`
      },
      asRun({ actor: admin })
    );
  }
  return db;
}

/** The one mail sent to `address`, once its send (not awaited by the operation) is done. */
async function mailTo(
  address: string
): Promise<{ subject: string; text: string }> {
  return vi.waitFor(() => {
    const mails = sent.filter(mail => mail.to === address);
    expect(mails).toHaveLength(1);
    return mails[0] as { subject: string; text: string };
  });
}

function createAs(
  db: Db,
  actor: Actor,
  role: string,
  email: string
): Promise<{ user: { id: string } }> {
  return runOperation(
    db,
    'users.create',
    { name: 'Ada', email, role },
    asRun({ actor })
  ) as Promise<{ user: { id: string } }>;
}

beforeEach(() => {
  sent.length = 0;
});

describe('an admin\'s mail template never reaches an owner (§10.2 "Templates")', () => {
  it('sends a new owner the shipped setup mail', async () => {
    const db = await withAdminOverrides();
    await createAs(db, owner, 'owner', 'new-owner@x.test');
    const mail = await mailTo('new-owner@x.test');
    expect(mail.subject).toBe('Set your password for Acme (pbx.test)');
    expect(mail.text).not.toContain(FOREIGN);
  });

  it("sends a user and an admin the admin's setup mail", async () => {
    const db = await withAdminOverrides();
    await createAs(db, admin, 'user', 'user@x.test');
    await createAs(db, owner, 'admin', 'admin2@x.test');
    for (const address of ['user@x.test', 'admin2@x.test']) {
      // eslint-disable-next-line no-await-in-loop -- each mail in turn
      const mail = await mailTo(address);
      expect(mail.subject).toBe('Action needed');
      expect(mail.text).toContain(FOREIGN);
    }
  });

  it('sends a user promoted to owner the shipped reset mail', async () => {
    const db = await withAdminOverrides();
    const { user } = await createAs(db, admin, 'user', 'promoted@x.test');
    await mailTo('promoted@x.test');
    sent.length = 0;
    await runOperation(
      db,
      'users.update',
      { id: user.id, role: 'owner' },
      asConfirmedRun()
    );
    const mail = await mailTo('promoted@x.test');
    expect(mail.subject).toBe('Reset your password for Acme (pbx.test)');
    expect(mail.text).not.toContain(FOREIGN);
  });

  it("sends the shipped reset mail when an owner resets an owner's password", async () => {
    const db = await withAdminOverrides();
    await seedUser(db, {
      id: 'owner2',
      name: 'Second Owner',
      email: 'owner2@x.test',
      role: 'owner',
      passwordHash: 'x'
    });
    await runOperation(db, 'users.resetPassword', { id: 'owner2' }, asRun());
    const mail = await mailTo('owner2@x.test');
    expect(mail.text).not.toContain(FOREIGN);
  });

  it("sends the shipped reset mail to an owner's forgot-password request, the admin's to an admin's", async () => {
    const db = await withAdminOverrides();
    for (const [address, client] of [
      ['owner@x.test', '198.51.100.1'],
      ['admin@x.test', '198.51.100.2']
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- each request in turn
      await requestPasswordReset(db, {
        clientAddress: () => client,
        body: () => Promise.resolve({ email: address })
      });
    }
    expect((await mailTo('owner@x.test')).text).not.toContain(FOREIGN);
    expect((await mailTo('admin@x.test')).text).toContain(FOREIGN);
  });

  it('sends an owner the shipped two-factor notice', async () => {
    const db = await withAdminOverrides();
    await runOperation(
      db,
      'mailTemplates.put',
      {
        kind: 'mfaChanged',
        language: 'en',
        subject: 'Nothing happened',
        bodyText: 'All is well.'
      },
      asRun({ actor: admin })
    );
    noticeMfaChange(db, testKeyring(), owner.id, { kind: 'reset' });
    expect((await mailTo('owner@x.test')).subject).toBe(
      'Two-factor sign-in changed for Acme (pbx.test)'
    );
  });
});

describe('a template test (§10.2 "Templates")', () => {
  it("sends an owner the tenant's override, as a preview", async () => {
    const db = await withAdminOverrides();
    await runOperation(db, 'mailTemplates.test', { kind: 'setup' }, asRun());
    expect((await mailTo('owner@x.test')).subject).toBe('Action needed');
  });
});

describe('the update mails are owner-only templates (§10.3)', () => {
  const updateFailed = {
    kind: 'updateFailed' as MailKind,
    language: 'en',
    subject: 'Update of {{fqdn}} failed',
    bodyText: 'Overridden for {{recipientName}}'
  };

  it('refuses an admin the write and removal of updateFailed and breakingUpdate', async () => {
    const db = await withAdminOverrides();
    for (const kind of ['updateFailed', 'breakingUpdate']) {
      // eslint-disable-next-line no-await-in-loop -- each kind in turn
      await expect(
        runOperation(
          db,
          'mailTemplates.put',
          { ...updateFailed, kind },
          asRun({ actor: admin })
        )
      ).rejects.toMatchObject({ status: 403 });
      // eslint-disable-next-line no-await-in-loop -- each kind in turn
      await runOperation(
        db,
        'mailTemplates.put',
        { ...updateFailed, kind },
        asRun()
      );
      // eslint-disable-next-line no-await-in-loop -- each kind in turn
      await expect(
        runOperation(
          db,
          'mailTemplates.delete',
          { kind, language: 'en' },
          asConfirmedRun({ actor: admin })
        )
      ).rejects.toMatchObject({ status: 403 });
      // eslint-disable-next-line no-await-in-loop -- each kind in turn
      await runOperation(
        db,
        'mailTemplates.delete',
        { kind, language: 'en' },
        asConfirmedRun()
      );
    }
  });

  it("refuses an admin the undo of an owner's write, through the replay's check", async () => {
    const db = await withAdminOverrides();
    await runOperation(db, 'mailTemplates.put', updateFailed, asRun());
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'mailTemplates.put')
      .where('entityId', '=', 'updateFailed:en')
      .executeTakeFirstOrThrow();
    await expect(
      runOperation(db, 'audit.undo', entry, asRun({ actor: admin }))
    ).rejects.toMatchObject({ status: 403 });
    await runOperation(db, 'audit.undo', entry, asRun());
  });

  it("sends the owners the owners' override", async () => {
    const db = await withAdminOverrides();
    await runOperation(db, 'mailTemplates.put', updateFailed, asRun());
    await mailOwners(db, updateMailSender(db, testKeyring()), userId => ({
      kind: 'updateFailed',
      to: { userId },
      values: {
        fromVersion: '1.2.3',
        toVersion: '1.2.4',
        reason: 'the backup failed',
        failedAt: '2026-11-13T03:00:00Z'
      }
    }));
    expect(await mailTo('owner@x.test')).toMatchObject({
      subject: 'Update of pbx.test failed',
      text: 'Overridden for Owner'
    });
  });
});
