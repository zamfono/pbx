import { randomBytes } from 'node:crypto';
import process from 'node:process';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { mfaMethods } from '@zamfono/shared';
import { migrateForTest, seedSettings } from '@zamfono/shared/testDb.js';

import { getDb } from '#lib/server/db.js';
import { cookieJar, type CookieJar } from '#testing/requestEvent.js';
import {
  ORIGIN,
  seedPerson,
  signIn,
  submitSecond
} from '#testing/signInKit.js';
import { SoftAuthenticator } from '#testing/softAuthenticator.js';

const KEY_BYTE_LENGTH = 32;

process.env.DB_FILE = ':memory:';
process.env.FQDN = 'pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await seedSettings(db, { companyName: 'Acme', language: 'en' });
});

/** The passkey options a step offers. */
function passkeyOf(step: unknown): object {
  if (
    !(step && typeof step === 'object' && 'passkey' in step) ||
    !step.passkey
  ) {
    throw new Error(`expected passkey options, got ${JSON.stringify(step)}`);
  }
  return step.passkey;
}

const registrationOf = (
  step: unknown
): PublicKeyCredentialCreationOptionsJSON =>
  passkeyOf(step) as PublicKeyCredentialCreationOptionsJSON;
const requestOf = (step: unknown): PublicKeyCredentialRequestOptionsJSON =>
  passkeyOf(step) as PublicKeyCredentialRequestOptionsJSON;

/** Signs `email` in for the first time and sets up `authenticator` as their passkey `name`. */
async function enrolPasskey(
  email: string,
  authenticator: SoftAuthenticator,
  name: string
): Promise<CookieJar> {
  const cookies = cookieJar();
  const options = registrationOf(await signIn(cookies, email));
  const codes = await submitSecond(cookies, {
    action: 'passkey',
    passkey: JSON.stringify(authenticator.register(options)),
    passkeyName: name
  });
  expect(codes).toMatchObject({ step: 'recoveryCodes' });
  expect(await submitSecond(cookies, { action: 'saved' })).toMatchObject({
    needsConsent: true
  });
  return cookies;
}

describe('a passkey as the second factor (§5.2 "Two-factor authentication")', () => {
  it('is offered at enrolment for this stack as the relying party, and set up there', async () => {
    const db = getDb();
    const userId = await seedPerson(db, 'enrol@example.com', 'owner');
    const options = registrationOf(
      await signIn(cookieJar(), 'enrol@example.com')
    );
    expect(options.rp).toEqual({ id: 'pbx.example.com', name: 'Acme' });
    expect(options.authenticatorSelection?.userVerification).toBe('preferred');
    await enrolPasskey(
      'enrol@example.com',
      new SoftAuthenticator(ORIGIN),
      'Laptop'
    );
    expect(await mfaMethods(db, userId)).toEqual({
      totp: false,
      passkeys: 1,
      recoveryCodesLeft: 10
    });
    const row = await db
      .selectFrom('webauthnCredentials')
      .select(['name', 'transportsJson'])
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ name: 'Laptop', transportsJson: '["internal"]' });
  });

  it('passes a later sign-in, counting the authenticator up', async () => {
    const db = getDb();
    const userId = await seedPerson(db, 'signin@example.com', 'admin');
    const authenticator = new SoftAuthenticator(ORIGIN);
    await enrolPasskey('signin@example.com', authenticator, 'Phone');
    const cookies = cookieJar();
    const options = requestOf(await signIn(cookies, 'signin@example.com'));
    expect(options.allowCredentials).toHaveLength(1);
    expect(
      await submitSecond(cookies, {
        action: 'passkey',
        passkey: JSON.stringify(authenticator.authenticate(options))
      })
    ).toMatchObject({ needsConsent: true });
    const row = await db
      .selectFrom('webauthnCredentials')
      .select(['signCount', 'lastUsedAt'])
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.signCount).toBe(1);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('refuses an answer to an earlier challenge, and one made for another origin', async () => {
    const authenticator = new SoftAuthenticator(ORIGIN);
    await seedPerson(getDb(), 'replay@example.com', 'owner');
    await enrolPasskey('replay@example.com', authenticator, 'Key');
    const first = cookieJar();
    const earlier = authenticator.authenticate(
      requestOf(await signIn(first, 'replay@example.com'))
    );
    const second = cookieJar();
    const options = requestOf(await signIn(second, 'replay@example.com'));
    const refused = {
      step: 'verify',
      error: 'The passkey could not be verified.'
    };
    expect(
      await submitSecond(second, {
        action: 'passkey',
        passkey: JSON.stringify(earlier)
      })
    ).toMatchObject(refused);
    const phished = new SoftAuthenticator('https://pbx.example.net');
    expect(
      await submitSecond(second, {
        action: 'passkey',
        passkey: JSON.stringify(phished.authenticate(options))
      })
    ).toMatchObject(refused);
  });

  it('refuses a registration answered for another challenge, setting nothing up', async () => {
    const db = getDb();
    const userId = await seedPerson(db, 'badreg@example.com', 'owner');
    const stale = registrationOf(
      await signIn(cookieJar(), 'badreg@example.com')
    );
    const cookies = cookieJar();
    await signIn(cookies, 'badreg@example.com');
    expect(
      await submitSecond(cookies, {
        action: 'passkey',
        passkey: JSON.stringify(new SoftAuthenticator(ORIGIN).register(stale))
      })
    ).toMatchObject({
      step: 'enrol',
      error: 'The passkey could not be verified.'
    });
    expect((await mfaMethods(db, userId)).passkeys).toBe(0);
  });
});
