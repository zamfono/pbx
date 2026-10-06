import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import * as privateEnv from '$app/env/private';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Db, type UserRole } from '@zamfono/shared';
import {
  migrateForTest,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import { encodeMetadataClientId } from '#lib/server/auth/clients.js';
import { totpAt } from '#lib/server/auth/mfa/totp.js';
import { hashPassword } from '#lib/server/auth/password.js';
import { getDb } from '#lib/server/db.js';
import { limiter } from '#lib/server/limiter.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import {
  cookieJar,
  requestEvent,
  type CookieJar
} from '#testing/requestEvent.js';

import { loginSubmit, type LoginResult } from './loginSubmit.js';
import { secondFactorSubmit } from './secondFactorSubmit.js';

const KEY_BYTE_LENGTH = 32;
const ORIGIN = 'https://pbx.example.com';
const PASSWORD = 'correct horse battery staple';
const STEP_MS = 30_000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BITS_PER_CHAR = 5;
const BITS_PER_BYTE = 8;
const RECOVERY_CODES = 10;
// §5.5: five failed attempts lock the account.
const LOCK_AFTER = 5;

process.env.DB_FILE = ':memory:';
process.env.FQDN = 'pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await seedSettings(db, { companyName: 'Acme', language: 'en' });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The secret an enrolment step shows as grouped base32, as an authenticator app reads it. */
function secretOf(result: LoginResult): Buffer {
  if (!('step' in result) || result.step !== 'enrol') {
    throw new Error(
      `expected the enrolment step, got ${JSON.stringify(result)}`
    );
  }
  let bits = '';
  for (const char of result.secret.replaceAll(' ', '')) {
    bits += BASE32.indexOf(char).toString(2).padStart(BITS_PER_CHAR, '0');
  }
  const bytes = bits.match(new RegExp(`.{${BITS_PER_BYTE}}`, 'gu')) ?? [];
  return Buffer.from(bytes.map(byte => Number.parseInt(byte, 2)));
}

async function seedPerson(
  db: Db,
  email: string,
  role: UserRole
): Promise<string> {
  return seedUser(db, {
    name: 'Anna',
    email,
    role,
    passwordHash: await hashPassword(PASSWORD)
  });
}

function eventFor(cookies: CookieJar): RequestEvent {
  return requestEvent(`${ORIGIN}/oauth/authorize`, {
    cookies,
    clientAddress: '203.0.113.1'
  });
}

/** A client the sign-in is for, so a passed sign-in answers the consent step, not a redirect. */
function forClient(): Record<string, string> {
  const redirectUri = 'https://client.example.com/callback';
  return {
    client_id: encodeMetadataClientId(keyringFromEnv(privateEnv), {
      name: 'Test Client',
      redirectUris: [redirectUri],
      applicationType: 'web'
    }),
    redirect_uri: redirectUri,
    code_challenge: 'challenge',
    scope: ''
  };
}

async function signIn(cookies: CookieJar, email: string): Promise<LoginResult> {
  return loginSubmit(eventFor(cookies), {
    ...forClient(),
    email,
    _password: PASSWORD,
    action: 'password'
  });
}

function submitCode(cookies: CookieJar, code: string): Promise<unknown> {
  return secondFactorSubmit(eventFor(cookies), { code, action: 'code' });
}

/** Enrols `email`'s authenticator through the sign-in, answering its secret and recovery codes. */
async function enrol(
  email: string
): Promise<{ secret: Buffer; codes: string[] }> {
  const cookies = cookieJar();
  const secret = secretOf(await signIn(cookies, email));
  const step = await submitCode(cookies, totpAt(secret, Date.now()));
  if (!(step && typeof step === 'object' && 'codes' in step)) {
    throw new Error('expected the recovery codes');
  }
  await secondFactorSubmit(eventFor(cookies), { code: '', action: 'saved' });
  return { secret, codes: step.codes as string[] };
}

describe('the second step of a password sign-in (§5.2 "Two-factor authentication")', () => {
  it('makes an owner without a second factor set one up before consent: the QR code and the secret', async () => {
    await seedPerson(getDb(), 'enrol-owner@example.com', 'owner');
    const result = await signIn(cookieJar(), 'enrol-owner@example.com');
    expect(result).toMatchObject({ step: 'enrol', error: null });
    if (!('qrSvg' in result)) {
      throw new Error('expected the enrolment step');
    }
    expect(result.qrSvg).toMatch(/^<svg /u);
    expect(secretOf(result)).toHaveLength(20);
  });

  it('refuses a wrong enrolment code with the same secret shown again', async () => {
    await seedPerson(getDb(), 'enrol-wrong@example.com', 'admin');
    const cookies = cookieJar();
    const first = await signIn(cookies, 'enrol-wrong@example.com');
    const again = await submitCode(cookies, '000000');
    expect(again).toMatchObject({ step: 'enrol', error: 'Incorrect code.' });
    expect(secretOf(again as LoginResult)).toEqual(secretOf(first));
  });

  it('stores the confirmed authenticator encrypted, shows ten recovery codes, then the consent step', async () => {
    const db = getDb();
    const userId = await seedPerson(db, 'enrol-ok@example.com', 'owner');
    const cookies = cookieJar();
    const secret = secretOf(await signIn(cookies, 'enrol-ok@example.com'));
    const codes = await submitCode(cookies, totpAt(secret, Date.now()));
    expect(codes).toMatchObject({ step: 'recoveryCodes' });
    expect((codes as { codes: string[] }).codes).toHaveLength(RECOVERY_CODES);
    const stored = await db
      .selectFrom('totpCredentials')
      .select('secretEnc')
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    expect(stored.secretEnc.includes(secret)).toBe(false);
    const hashes = await db
      .selectFrom('recoveryCodes')
      .select('codeHash')
      .where('userId', '=', userId)
      .execute();
    expect(hashes).toHaveLength(RECOVERY_CODES);
    expect(hashes.map(row => row.codeHash)).not.toContain(
      (codes as { codes: string[] }).codes[0]
    );
    const done = await secondFactorSubmit(eventFor(cookies), {
      code: '',
      action: 'saved'
    });
    expect(done).toMatchObject({
      needsConsent: true,
      clientName: 'Test Client'
    });
    expect(cookies.written.has('zamfono_consent')).toBe(true);
    expect(cookies.written.has('zamfono_mfa')).toBe(false);
  });

  it('asks a later sign-in for the code, refuses the step already used and takes the next', async () => {
    await seedPerson(getDb(), 'replay@example.com', 'owner');
    const { secret } = await enrol('replay@example.com');
    const cookies = cookieJar();
    expect(await signIn(cookies, 'replay@example.com')).toEqual({
      step: 'verify',
      error: null
    });
    // The enrolment's own code: its step is spent.
    expect(await submitCode(cookies, totpAt(secret, Date.now()))).toEqual({
      step: 'verify',
      error: 'Incorrect code.'
    });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + STEP_MS });
    expect(await submitCode(cookies, totpAt(secret, Date.now()))).toMatchObject(
      { needsConsent: true }
    );
  });

  it('passes a recovery code once, in any case and grouping', async () => {
    await seedPerson(getDb(), 'recovery@example.com', 'admin');
    const { codes } = await enrol('recovery@example.com');
    const [code = ''] = codes;
    const first = cookieJar();
    await signIn(first, 'recovery@example.com');
    expect(
      await submitCode(first, code.toLowerCase().replaceAll('-', ' '))
    ).toMatchObject({ needsConsent: true });
    const second = cookieJar();
    await signIn(second, 'recovery@example.com');
    expect(await submitCode(second, code)).toEqual({
      step: 'verify',
      error: 'Incorrect code.'
    });
  });

  it('counts codes toward the account lock, which then refuses a right one too (§5.5)', async () => {
    await seedPerson(getDb(), 'lock@example.com', 'owner');
    const { secret } = await enrol('lock@example.com');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + STEP_MS });
    const cookies = cookieJar();
    await signIn(cookies, 'lock@example.com');
    // The password attempt counts until the whole sign-in passes: four wrong codes reach five.
    for (let attempt = 1; attempt < LOCK_AFTER; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts are the point of this loop
      await submitCode(cookies, '000000');
    }
    expect(limiter.isLocked('lock@example.com').locked).toBe(true);
    expect(await submitCode(cookies, totpAt(secret, Date.now()))).toEqual({
      step: 'verify',
      error: 'Incorrect code.'
    });
  });

  it('signs a user in without a second step until the setting requires one of everybody', async () => {
    const db = getDb();
    await seedPerson(db, 'plain@example.com', 'user');
    expect(await signIn(cookieJar(), 'plain@example.com')).toMatchObject({
      needsConsent: true
    });
    await db.updateTable('settings').set({ mfaRequiredForAll: 1 }).execute();
    try {
      expect(await signIn(cookieJar(), 'plain@example.com')).toMatchObject({
        step: 'enrol'
      });
    } finally {
      await db.updateTable('settings').set({ mfaRequiredForAll: 0 }).execute();
    }
  });

  it('sends a bare sign-in to the landing page once its second step passed', async () => {
    await seedPerson(getDb(), 'bare@example.com', 'owner');
    const { secret } = await enrol('bare@example.com');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + STEP_MS });
    const cookies = cookieJar();
    await loginSubmit(eventFor(cookies), {
      email: 'bare@example.com',
      _password: PASSWORD,
      action: 'password'
    });
    const err = await submitCode(cookies, totpAt(secret, Date.now())).catch(
      (caught: unknown) => caught
    );
    expect(isRedirect(err) && err.location).toBe(`${ORIGIN}/auth/done`);
  });

  it('answers a code without a pending sign-in with the error page', async () => {
    const err = await submitCode(cookieJar(), '123456').catch(
      (caught: unknown) => caught
    );
    expect(isHttpError(err) && err.status).toBe(400);
  });
});
