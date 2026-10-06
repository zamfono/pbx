/**
 * A password sign-in at `/oauth/authorize` and its second step, as the route tests drive them
 * (§5.2 "Two-factor authentication"). A test file using it sets `FQDN` to `pbx.example.com`.
 */
import type { RequestEvent } from '@sveltejs/kit';
import * as privateEnv from '$app/env/private';

import type { Db, UserRole } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { encodeMetadataClientId } from '#lib/server/auth/clients.js';
import {
  secondFactorSubmit,
  type SecondFactorPayload
} from '#lib/server/auth/mfa/secondFactorSubmit.js';
import { hashPassword } from '#lib/server/auth/password.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import {
  loginSubmit,
  type LoginResult
} from '../routes/oauth/authorize/loginSubmit.js';
import { requestEvent, type CookieJar } from './requestEvent.js';

export const ORIGIN = 'https://pbx.example.com';
export const PASSWORD = 'correct horse battery staple';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BITS_PER_CHAR = 5;
const BITS_PER_BYTE = 8;
const BINARY = 2;

/** A user `email` of `role` signing in with `PASSWORD`. */
export async function seedPerson(
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

/** A request to the login page carrying `cookies`, as the browser's next request would. */
export function eventFor(cookies: CookieJar): RequestEvent {
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

/** The password step of `email` for the test client. */
export async function signIn(
  cookies: CookieJar,
  email: string
): Promise<LoginResult> {
  return loginSubmit(eventFor(cookies), {
    ...forClient(),
    email,
    _password: PASSWORD,
    action: 'password'
  });
}

/** A submission of the second step's form, its fields empty but those `fields` names. */
export function submitSecond(
  cookies: CookieJar,
  fields: Partial<SecondFactorPayload> & Pick<SecondFactorPayload, 'action'>
): Promise<unknown> {
  return secondFactorSubmit(eventFor(cookies), {
    code: '',
    passkey: '',
    passkeyName: '',
    ...fields
  });
}

/** The secret an enrolment step shows as grouped base32, as an authenticator app reads it. */
export function secretOf(result: unknown): Buffer {
  if (
    !(result && typeof result === 'object' && 'secret' in result) ||
    typeof result.secret !== 'string'
  ) {
    throw new Error(
      `expected the enrolment step, got ${JSON.stringify(result)}`
    );
  }
  let bits = '';
  for (const char of result.secret.replaceAll(' ', '')) {
    bits += BASE32.indexOf(char).toString(BINARY).padStart(BITS_PER_CHAR, '0');
  }
  const bytes = bits.match(new RegExp(`.{${BITS_PER_BYTE}}`, 'gu')) ?? [];
  return Buffer.from(bytes.map(byte => Number.parseInt(byte, BINARY)));
}
