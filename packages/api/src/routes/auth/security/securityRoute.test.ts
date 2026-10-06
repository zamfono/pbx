import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { mfaMethods, type UserRole } from '@zamfono/shared';
import {
  migrateForTest,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import {
  securitySession,
  startSecuritySession
} from '#lib/server/auth/mfa/securitySession.js';
import { totpAt } from '#lib/server/auth/mfa/totp.js';
import { getDb } from '#lib/server/db.js';
import { sendMail } from '#lib/server/mail/index.js';
import {
  cookieJar,
  requestEvent,
  type CookieJar
} from '#testing/requestEvent.js';
import {
  ORIGIN,
  PASSWORD,
  secretOf,
  seedPerson,
  submitSecond
} from '#testing/signInKit.js';
import { SoftAuthenticator } from '#testing/softAuthenticator.js';

import { load } from './+page.server.js';
import type { ManageResult } from './securityAccount.js';
import {
  manageSubmit,
  removePasskeySubmit,
  type ManagePayload
} from './securityManage.js';
import { securitySignIn } from './securitySignIn.js';

const KEY_BYTE_LENGTH = 32;

process.env.DB_FILE = ':memory:';
process.env.FQDN = 'pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

vi.mock('#lib/server/mail/index.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/mail/index.js')>();
  return { ...actual, sendMail: vi.fn(() => Promise.resolve('sent')) };
});

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await seedSettings(db, { companyName: 'Acme', language: 'en' });
});

function pageEvent(cookies: CookieJar): RequestEvent {
  return requestEvent(`${ORIGIN}/auth/security`, {
    cookies,
    clientAddress: '203.0.113.2'
  });
}

/** Where `promise` redirects to, `undefined` when it settles any other way. */
async function redirectOf(
  promise: Promise<unknown>
): Promise<string | undefined> {
  const outcome = await promise.catch((caught: unknown) => caught);
  return isRedirect(outcome) ? outcome.location : undefined;
}

function manage(
  cookies: CookieJar,
  fields: Partial<ManagePayload> & Pick<ManagePayload, 'action'>
): Promise<ManageResult> {
  return manageSubmit(pageEvent(cookies), {
    code: '',
    passkey: '',
    passkeyName: '',
    ...fields
  });
}

/** A user of `role` without a second factor, signed in to the page. */
async function openPage(email: string, role: UserRole): Promise<CookieJar> {
  await seedPerson(getDb(), email, role);
  const cookies = cookieJar();
  expect(
    await redirectOf(
      securitySignIn(pageEvent(cookies), {
        email,
        _password: PASSWORD,
        action: 'password'
      })
    )
  ).toBe('/auth/security');
  return cookies;
}

/** Sets up an authenticator for the page's user, answering its secret and the result. */
async function setUpTotp(
  cookies: CookieJar
): Promise<{ secret: Buffer; result: ManageResult }> {
  const setup = await manage(cookies, { action: 'totpStart' });
  const secret = secretOf(setup.totpSetup);
  const result = await manage(cookies, {
    action: 'totpConfirm',
    code: totpAt(secret, Date.now())
  });
  return { secret, result };
}

describe('the security page (§5.2 "Authentication pages", "Two-factor authentication")', () => {
  it('shows only its sign-in without its own session, never for a token or another cookie', async () => {
    const data = await load(
      pageEvent(cookieJar()) as Parameters<typeof load>[0]
    );
    expect(data).toMatchObject({ manage: null });
    expect(await redirectOf(manage(cookieJar(), { action: 'codes' }))).toBe(
      '/auth/security'
    );
  });

  it('holds its session to the login rule: not for an owner without a password, nor a user without an e-mail', async () => {
    const db = getDb();
    const owner = await seedUser(db, {
      email: 'nopassword@example.com',
      role: 'owner',
      passwordHash: null
    });
    const phoneOnly = await seedUser(db, { email: null, ext: '4711' });
    for (const userId of [owner, phoneOnly]) {
      const cookies = cookieJar();
      startSecuritySession(cookies, userId);
      // eslint-disable-next-line no-await-in-loop -- one user after the other keeps the cases apart
      const data = await load(pageEvent(cookies) as Parameters<typeof load>[0]);
      expect(data).toMatchObject({ manage: null });
      // eslint-disable-next-line no-await-in-loop -- as above
      expect(await redirectOf(manage(cookies, { action: 'codes' }))).toBe(
        '/auth/security'
      );
    }
  });

  it('refuses a wrong password like the login page', async () => {
    await seedPerson(getDb(), 'wrong@example.com', 'user');
    expect(
      await securitySignIn(pageEvent(cookieJar()), {
        email: 'wrong@example.com',
        _password: 'nope',
        action: 'password'
      })
    ).toEqual({
      message: 'Incorrect e-mail or password.',
      email: 'wrong@example.com'
    });
  });

  it('sets up a first authenticator, issuing recovery codes and mailing the user', async () => {
    const cookies = await openPage('first@example.com', 'user');
    const userId = securitySession(cookies)?.userId ?? '';
    const { result } = await setUpTotp(cookies);
    expect(result.codes).toHaveLength(10);
    expect(await mfaMethods(getDb(), userId)).toMatchObject({ totp: true });
    expect(sendMail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'mfaChanged', to: { userId } })
    );
  });

  it('asks a user with a second factor for it before opening the page', async () => {
    const cookies = await openPage('again@example.com', 'user');
    const { secret } = await setUpTotp(cookies);
    const fresh = cookieJar();
    expect(
      await securitySignIn(pageEvent(fresh), {
        email: 'again@example.com',
        _password: PASSWORD,
        action: 'password'
      })
    ).toMatchObject({ step: 'verify' });
    expect(securitySession(fresh)).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 30_000 });
    try {
      expect(
        await redirectOf(
          submitSecond(fresh, {
            action: 'code',
            code: totpAt(secret, Date.now())
          })
        )
      ).toBe('/auth/security');
    } finally {
      vi.useRealTimers();
    }
    expect(securitySession(fresh)).not.toBeNull();
  });

  it('adds a passkey against the options the page shows, and removes it again', async () => {
    const cookies = await openPage('passkey@example.com', 'user');
    const data = await load(pageEvent(cookies) as Parameters<typeof load>[0]);
    if (data.manage === null) {
      throw new Error('expected the signed-in page');
    }
    const authenticator = new SoftAuthenticator(ORIGIN);
    const added = await manage(cookies, {
      action: 'passkeyAdd',
      passkey: JSON.stringify(
        authenticator.register(data.manage.passkeyOptions)
      ),
      passkeyName: 'Laptop'
    });
    expect(added.codes).toHaveLength(10);
    const reloaded = await load(
      pageEvent(cookies) as Parameters<typeof load>[0]
    );
    const [passkey] = reloaded.manage?.passkeys ?? [];
    expect(passkey).toMatchObject({ name: 'Laptop', lastUsedAt: null });
    await removePasskeySubmit(pageEvent(cookies), passkey?.id ?? '');
    const userId = securitySession(cookies)?.userId ?? '';
    // The last method gone, its recovery codes go too.
    expect(await mfaMethods(getDb(), userId)).toEqual({
      totp: false,
      passkeys: 0,
      recoveryCodesLeft: 0
    });
  });

  it("keeps a required user's last method, removing it only once another is there", async () => {
    const cookies = await openPage('admin@example.com', 'admin');
    await setUpTotp(cookies);
    const refused = await manage(cookies, { action: 'totpRemove' });
    expect(refused.error).toMatch(/must keep a second factor/u);
    const userId = securitySession(cookies)?.userId ?? '';
    expect((await mfaMethods(getDb(), userId)).totp).toBe(true);
  });

  it('regenerates the recovery codes, replacing the old ones', async () => {
    const cookies = await openPage('codes@example.com', 'user');
    const { result } = await setUpTotp(cookies);
    const fresh = await manage(cookies, { action: 'codes' });
    expect(fresh.codes).toHaveLength(10);
    expect(fresh.codes).not.toEqual(result.codes);
  });
});
