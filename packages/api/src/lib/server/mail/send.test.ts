import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import type { Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, type Db, type MailRequest } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { voicemailAttachment } from '../audio/transcode.js';
import { keyringFromEnv, type Keyring } from '../secretbox.js';
import { seedSettings } from '../testDb.js';
import { relayFromSettings } from './relay.js';
import { sendMail, type SetupOrResetRequest } from './send.js';

const KEY_BYTE_LENGTH = 32;

// The real transcode shells out to `ffmpeg`; these tests assert which bytes reach the relay,
// so the transcode stands in as a stub that records the path it was handed.
vi.mock('../audio/transcode.js', () => ({
  voicemailAttachment: vi.fn((source: string) => ({
    filename: `${path.basename(source, path.extname(source))}.mp3`,
    read: () => Promise.resolve(Buffer.from('fake-mp3')),
    contentType: 'audio/mpeg'
  }))
}));

// The send's own warnings, so a test can read what a failed send logged (§7: a line about a call
// carries its id).
const warnings = vi.hoisted((): Record<string, unknown>[] => []);
vi.mock('pino', () => ({
  default: () => ({
    info: () => undefined,
    error: () => undefined,
    warn: (fields: Record<string, unknown>) => {
      warnings.push(fields);
    }
  })
}));

function testKeyring(): Keyring {
  return keyringFromEnv({
    SECRETBOX_KEY: `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`
  });
}

/** A migrated in-memory database. */
async function migratedDb(): Promise<Db> {
  const db = await migratedTestDb();
  return db;
}

/** Inserts the `settings` singleton, with a relay configured unless `smtpHost` is `null`. */
async function insertSettings(
  db: Db,
  overrides: { smtpHost: string | null }
): Promise<void> {
  await seedSettings(db, {
    companyName: 'Acme',
    smtpHost: overrides.smtpHost,
    mailFrom: overrides.smtpHost === null ? null : 'no-reply@example.test'
  });
}

async function insertUser(db: Db, id: string, email: string): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Voicemail Owner',
      email,
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
}

function fakeTransport(): { transport: Transporter; sent: unknown[] } {
  const sent: unknown[] = [];
  const transport = {
    sendMail: vi.fn((message: unknown) => {
      sent.push(message);
      return Promise.resolve({});
    })
  } as unknown as Transporter;
  return { transport, sent };
}

describe('relayFromSettings', () => {
  it('is null while smtp_host is unset', async () => {
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: null });
    await expect(relayFromSettings(db, testKeyring())).resolves.toBeNull();
  });

  it('is null when smtp_host is set but mail_from is not', async () => {
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: 'smtp.example.test' });
    await db
      .updateTable('settings')
      .set({ mailFrom: null })
      .where('id', '=', 1)
      .execute();
    await expect(relayFromSettings(db, testKeyring())).resolves.toBeNull();
  });
});

describe('sendMail', () => {
  const originalFqdn = process.env.FQDN;

  afterEach(() => {
    if (originalFqdn === undefined) {
      delete process.env.FQDN;
    } else {
      process.env.FQDN = originalFqdn;
    }
  });

  it('sends a voicemail mail with the recipient, subject and attachment', async () => {
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: 'smtp.example.test' });
    await insertUser(db, 'u1', 'user@example.test');
    const { transport, sent } = fakeTransport();

    const req: MailRequest = {
      kind: 'voicemail',
      to: { userId: 'u1' },
      values: {
        callerNumber: '+491111111',
        callerName: 'Alice',
        mailboxName: 'Voicemail Owner',
        receivedAt: '2026-06-15T12:00:00.000Z',
        durationS: 12
      },
      attachmentPath: '/media/voicemail/vm1.wav'
    };

    const result = await sendMail(db, testKeyring(), req, { transport });
    expect(result).toBe('sent');
    expect(sent).toHaveLength(1);
    const message = sent[0] as {
      to: string;
      subject: string;
      attachments?: {
        filename: string;
        content: Buffer;
        contentType: string;
      }[];
    };
    expect(message.to).toBe('user@example.test');
    expect(message.subject).toContain('Alice');
    expect(voicemailAttachment).toHaveBeenCalledWith(
      '/media/voicemail/vm1.wav'
    );
    expect(message.attachments).toEqual([
      {
        filename: 'vm1.mp3',
        content: Buffer.from('fake-mp3'),
        contentType: 'audio/mpeg'
      }
    ]);
  });

  it('sends the notification without an attachment when the transcode fails', async () => {
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: 'smtp.example.test' });
    await insertUser(db, 'u1', 'user@example.test');
    const { transport, sent } = fakeTransport();
    vi.mocked(voicemailAttachment).mockReturnValueOnce({
      filename: 'vm1.mp3',
      read: () => Promise.reject(new Error('ffmpeg: exit 1')),
      contentType: 'audio/mpeg'
    });

    const req: MailRequest = {
      kind: 'voicemail',
      callId: 'call-1',
      to: { userId: 'u1' },
      values: {
        callerNumber: '+491111111',
        callerName: 'Alice',
        mailboxName: 'Voicemail Owner',
        receivedAt: '2026-06-15T12:00:00.000Z',
        durationS: 12
      },
      attachmentPath: '/media/voicemail/vm1.wav'
    };

    const result = await sendMail(db, testKeyring(), req, { transport });
    expect(result).toBe('sent');
    const message = sent[0] as { attachments?: unknown };
    expect(message.attachments).toBeUndefined();
    expect(warnings.at(-1)).toMatchObject({ callId: 'call-1' });
  });

  it('names the call in the line logged when a mail about it cannot be sent (§7)', async () => {
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: 'smtp.example.test' });
    await insertUser(db, 'u1', 'user@example.test');
    const transport = {
      sendMail: vi.fn(() => Promise.reject(new Error('relay down')))
    } as unknown as Transporter;

    const req: MailRequest = {
      kind: 'missedCall',
      callId: 'call-2',
      to: { userId: 'u1' },
      values: {
        callerNumber: '+491111111',
        callerName: 'Alice',
        receivedAt: '2026-06-15T12:00:00.000Z',
        didLabel: 'Main line'
      }
    };

    const result = await sendMail(db, testKeyring(), req, {
      transport,
      attempts: 1
    });
    expect(result).toBe('failed');
    expect(warnings.at(-1)).toMatchObject({
      kind: 'missedCall',
      callId: 'call-2'
    });
  });

  it('bccs a ring group with several members instead of sharing one To header', async () => {
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: 'smtp.example.test' });
    await insertUser(db, 'u1', 'one@example.test');
    await insertUser(db, 'u2', 'two@example.test');
    await db
      .insertInto('ringGroups')
      .values({
        id: 'rg1',
        name: 'Support',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values([
        { groupId: 'rg1', position: 1, userId: 'u1', userGroupId: null },
        { groupId: 'rg1', position: 2, userId: 'u2', userGroupId: null }
      ])
      .execute();
    const { transport, sent } = fakeTransport();

    const req: MailRequest = {
      kind: 'voicemail',
      to: { ringGroupId: 'rg1' },
      values: {
        callerNumber: '+491111111',
        callerName: 'Alice',
        mailboxName: 'Support',
        receivedAt: '2026-06-15T12:00:00.000Z',
        durationS: 12
      },
      attachmentPath: '/media/voicemail/vm1.mp3'
    };

    const result = await sendMail(db, testKeyring(), req, { transport });
    expect(result).toBe('sent');
    const message = sent[0] as {
      to?: { name: string; address: string };
      bcc?: string[];
    };
    expect(message.bcc).toEqual(['one@example.test', 'two@example.test']);
    expect(message.to).toEqual({
      name: 'Acme',
      address: 'no-reply@example.test'
    });
  });

  it('returns skipped while no relay is configured', async () => {
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: null });
    await insertUser(db, 'u1', 'user@example.test');
    const { transport } = fakeTransport();

    const req: MailRequest = {
      kind: 'missedCall',
      to: { userId: 'u1' },
      values: {
        callerNumber: '+491111111',
        callerName: 'Alice',
        receivedAt: '2026-06-15T12:00:00.000Z',
        didLabel: 'Main line'
      }
    };

    const result = await sendMail(db, testKeyring(), req, { transport });
    expect(result).toBe('skipped');
  });

  it('renders a non-empty fqdn from FQDN', async () => {
    process.env.FQDN = 'pbx.example.test';
    const db = await migratedDb();
    await insertSettings(db, { smtpHost: 'smtp.example.test' });
    await insertUser(db, 'u1', 'user@example.test');
    const { transport, sent } = fakeTransport();

    const req: SetupOrResetRequest = {
      kind: 'setup',
      to: { userId: 'u1' },
      values: {
        link: 'https://pbx.example.test/setup/tok',
        linkExpiresAt: '2026-06-16T12:00:00.000Z'
      }
    };

    const result = await sendMail(db, testKeyring(), req, { transport });
    expect(result).toBe('sent');
    const message = sent[0] as { text: string };
    expect(message.text).toContain('pbx.example.test');
  });
});
