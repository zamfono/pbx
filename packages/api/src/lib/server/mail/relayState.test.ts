import type { Transporter } from 'nodemailer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migratedTestDb, seedSettings } from '@zamfono/shared/testDb.js';

import { testKeyring } from '#testing/fixtures.js';

import {
  classifyRelayError,
  forgetRelayOutcomes,
  relayOutcomeRecorder,
  relayState
} from './relayState.js';
import { sendMail } from './send.js';

vi.mock('pino', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

/** An error as nodemailer raises it: its message, `code` and, for a system error, `syscall`. */
function smtpError(
  message: string,
  code: string,
  syscall?: string
): Error & { code: string; syscall?: string } {
  return Object.assign(new Error(message), { code, syscall });
}

beforeEach(() => {
  forgetRelayOutcomes();
});

describe('classifyRelayError (§10.2 "Relay check")', () => {
  it.each([
    ['ECONNECTION', undefined, 'unreachable'],
    ['ETIMEDOUT', undefined, 'unreachable'],
    ['EDNS', 'getaddrinfo', 'unreachable'],
    ['ESOCKET', 'connect', 'unreachable'],
    ['EPROTOCOL', undefined, 'unreachable'],
    ['ESOCKET', undefined, 'tls'],
    ['ETLS', undefined, 'tls'],
    ['EAUTH', undefined, 'authentication'],
    ['ENOAUTH', undefined, 'authentication'],
    ['EENVELOPE', undefined, 'rejected'],
    ['EMESSAGE', undefined, 'rejected']
  ])('maps %s (syscall %s) to %s', (code, syscall, expected) => {
    expect(classifyRelayError(smtpError('x', code, syscall))).toBe(expected);
  });

  it('maps an error without a code to unreachable', () => {
    expect(classifyRelayError(new Error('x'))).toBe('unreachable');
    expect(classifyRelayError(undefined)).toBe('unreachable');
  });
});

describe('relayOutcomeRecorder', () => {
  it("keeps the latest outcome with the relay's own message", () => {
    expect(relayState()).toBeNull();
    relayOutcomeRecorder().ok();
    expect(relayState()).toMatchObject({ ok: true, error: null });
    relayOutcomeRecorder().failed(
      smtpError('Invalid login: 535 5.7.8 bad credentials', 'EAUTH')
    );
    expect(relayState()).toEqual({
      ok: false,
      at: expect.any(String) as unknown,
      error: {
        class: 'authentication',
        message: 'Invalid login: 535 5.7.8 bad credentials'
      }
    });
  });

  it('drops the outcome of a check that began before the relay changed', () => {
    const before = relayOutcomeRecorder();
    forgetRelayOutcomes();
    before.failed(smtpError('connect ECONNREFUSED', 'ESOCKET', 'connect'));
    expect(relayState()).toBeNull();
  });
});

describe('sendMail records the outcome of each delivery attempt', () => {
  async function relayDb(): ReturnType<typeof migratedTestDb> {
    const db = await migratedTestDb();
    await seedSettings(db, {
      smtpHost: 'smtp.example.test',
      mailFrom: 'no-reply@example.test'
    });
    await db
      .insertInto('users')
      .values({
        id: 'u1',
        name: 'User',
        email: 'u1@example.test',
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
    return db;
  }

  const request = {
    kind: 'reset',
    to: { userId: 'u1' },
    values: { link: 'https://x.test/r', linkExpiresAt: nowIso() }
  } as const;

  it('as rejected when the relay refuses the message, and as a success once it takes one', async () => {
    const db = await relayDb();
    const sendFn = vi
      .fn()
      .mockRejectedValueOnce(
        smtpError('Message failed: 554 5.7.1 spam', 'EMESSAGE')
      )
      .mockResolvedValueOnce({});
    const transport = { sendMail: sendFn } as unknown as Transporter;

    await expect(
      sendMail(db, testKeyring(), request, { transport, attempts: 1 })
    ).resolves.toBe('failed');
    expect(relayState()?.error).toEqual({
      class: 'rejected',
      message: 'Message failed: 554 5.7.1 spam'
    });

    await expect(
      sendMail(db, testKeyring(), request, { transport, attempts: 1 })
    ).resolves.toBe('sent');
    expect(relayState()).toMatchObject({ ok: true, error: null });
  });
});
