import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/server';
import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import { getDb } from '#lib/server/db.js';

import { loadBranding } from '../branding.js';
import { authenticationOptions, registrationOptions } from './passkeys.js';
import { qrSvg } from './qr.js';
import {
  updateSecondFactorLogin,
  type SecondFactorLogin
} from './secondFactorLogin.js';
import { base32Encode, groupedSecret, otpauthUri } from './totp.js';

/** The second step the page renders (§5.2 "Two-factor authentication"): a code or passkey to
 *  verify (`passkey` the browser's request options while the user has one), a method to set up
 *  (an authenticator's QR code and secret as text, or a passkey through the browser's own
 *  prompt), or the recovery codes enrolment issued, shown once. `error` refuses the last try. */
export type SecondFactorStep =
  | {
      step: 'verify';
      passkey: PublicKeyCredentialRequestOptionsJSON | null;
      error: string | null;
    }
  | {
      step: 'enrol';
      qrSvg: string;
      secret: string;
      passkey: PublicKeyCredentialCreationOptionsJSON;
      error: string | null;
    }
  | { step: 'recoveryCodes'; codes: string[] };

/** The name a passkey or authenticator is issued under: the company name, else the FQDN. */
export async function issuer(): Promise<string> {
  const { companyName } = await loadBranding(getDb());
  return companyName === '' ? env.FQDN : companyName;
}

/** What an authenticator app's setup shows for `secret`: the `otpauth` URI as a QR code, issued
 *  as `name` for `email`, and the secret as grouped base32 text. */
export function totpSetup(
  name: string,
  email: string,
  secret: Buffer
): { qrSvg: string; secret: string } {
  return {
    qrSvg: qrSvg(otpauthUri(name, email, secret)),
    secret: groupedSecret(base32Encode(secret))
  };
}

/** The verify step for `login`, with a fresh passkey challenge where the user has a passkey; the
 *  challenge replaces the one the pending sign-in held, so each is answered once at most. */
export async function verifyStep(
  event: RequestEvent,
  login: SecondFactorLogin,
  error: string | null
): Promise<SecondFactorStep> {
  const options = await authenticationOptions(getDb(), login.userId);
  const hasPasskey = (options.allowCredentials ?? []).length > 0;
  updateSecondFactorLogin(event.cookies, {
    ...login,
    challenge: hasPasskey ? options.challenge : null
  });
  return { step: 'verify', passkey: hasPasskey ? options : null, error };
}

/** The enrolment step for `login`'s pending authenticator secret: the `otpauth` URI as a QR code
 *  for the e-mail the person signed in with, and a fresh passkey registration challenge. */
export async function enrolStep(
  event: RequestEvent,
  login: SecondFactorLogin & { totpSecret: Buffer },
  error: string | null
): Promise<SecondFactorStep> {
  const name = await issuer();
  const options = await registrationOptions(
    getDb(),
    { id: login.userId, email: login.email },
    name
  );
  updateSecondFactorLogin(event.cookies, {
    ...login,
    challenge: options.challenge
  });
  return {
    step: 'enrol',
    ...totpSetup(name, login.email, login.totpSecret),
    passkey: options,
    error
  };
}
