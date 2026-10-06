/**
 * Passkeys as a second factor (§5.2 "Two-factor authentication", §11.2 `webauthn_credentials`),
 * over `@simplewebauthn/server`: the relying party is the stack's FQDN at `https://<FQDN>`, user
 * verification is preferred, never required, since the password is already the first factor, and
 * no attestation is asked for.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential
} from '@simplewebauthn/server';
import * as env from '$app/env/private';
import { z } from 'zod';

import { newId, type Db } from '@zamfono/shared';

import { tryParseJson } from '#lib/server/json.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

const NO_ROWS = 0n;
const TransportsSchema = z.array(z.string());

/** The browser's response, `null` when `json` is no JSON object; the library checks the rest. */
function responseOf(json: string): object | null {
  const parsed = tryParseJson(json);
  return parsed !== null && typeof parsed === 'object' ? parsed : null;
}

async function storedCredentials(
  db: Db,
  userId: string
): Promise<{ id: string; transports?: string[] }[]> {
  const rows = await db
    .selectFrom('webauthnCredentials')
    .select(['credentialId', 'transportsJson'])
    .where('userId', '=', userId)
    .execute();
  return rows.map(row => {
    const transports = TransportsSchema.safeParse(
      tryParseJson(row.transportsJson ?? 'null')
    );
    return transports.success
      ? { id: row.credentialId, transports: transports.data }
      : { id: row.credentialId };
  });
}

/** Options for registering a new passkey of `user`, excluding the ones they already have. */
export async function registrationOptions(
  db: Db,
  user: { id: string; email: string },
  rpName: string
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName,
    rpID: env.FQDN,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: await storedCredentials(db, user.id),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred'
    }
  });
}

/**
 * Verifies a registration `responseJson` against the `challenge` its options carried and stores
 * the passkey as `name`; `false` for a response that does not verify.
 */
export async function registerPasskey(
  db: Db,
  {
    userId,
    challenge,
    name
  }: { userId: string; challenge: string; name: string },
  responseJson: string,
  now: string
): Promise<boolean> {
  const response = responseOf(responseJson) as RegistrationResponseJSON | null;
  const verified =
    response === null
      ? undefined
      : await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: originFromEnv(),
          expectedRPID: env.FQDN,
          requireUserVerification: false
        }).catch(() => undefined);
  if (verified?.verified !== true) {
    return false;
  }
  const { credential } = verified.registrationInfo;
  await db
    .insertInto('webauthnCredentials')
    .values({
      id: newId(),
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      signCount: credential.counter,
      transportsJson:
        credential.transports === undefined
          ? null
          : JSON.stringify(credential.transports),
      name,
      createdAt: now,
      lastUsedAt: null
    })
    .execute();
  return true;
}

/** Options for signing in with one of `userId`'s passkeys. */
export async function authenticationOptions(
  db: Db,
  userId: string
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: env.FQDN,
    allowCredentials: await storedCredentials(db, userId),
    userVerification: 'preferred'
  });
}

/**
 * Whether `responseJson` is a valid sign-in with one of `userId`'s passkeys against `challenge`:
 * the signature verifies and the authenticator's counter has not gone back (the library refuses
 * that). The new counter and the time of use are stored.
 */
export async function verifyPasskey(
  db: Db,
  userId: string,
  { challenge, responseJson }: { challenge: string; responseJson: string },
  now: string
): Promise<boolean> {
  const response = responseOf(
    responseJson
  ) as AuthenticationResponseJSON | null;
  const row =
    response === null || typeof response.id !== 'string'
      ? undefined
      : await db
          .selectFrom('webauthnCredentials')
          .selectAll()
          .where('userId', '=', userId)
          .where('credentialId', '=', response.id)
          .executeTakeFirst();
  if (response === null || row === undefined) {
    return false;
  }
  const credential: WebAuthnCredential = {
    id: row.credentialId,
    publicKey: new Uint8Array(row.publicKey),
    counter: row.signCount
  };
  // The library throws for a response it refuses (a wrong challenge, origin or signature, a
  // counter gone back), which is a refusal like any other here.
  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: originFromEnv(),
    expectedRPID: env.FQDN,
    credential,
    requireUserVerification: false
  }).catch(() => undefined);
  if (verified?.verified !== true) {
    return false;
  }
  // Guarded on the counter it was verified against, so of two requests with the same response
  // only one passes.
  const { numUpdatedRows } = await db
    .updateTable('webauthnCredentials')
    .set({ signCount: verified.authenticationInfo.newCounter, lastUsedAt: now })
    .where('id', '=', row.id)
    .where('signCount', '=', row.signCount)
    .executeTakeFirst();
  return numUpdatedRows > NO_ROWS;
}
