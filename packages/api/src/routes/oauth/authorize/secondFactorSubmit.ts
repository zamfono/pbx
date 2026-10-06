import { error, type RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import { z } from 'zod';

import {
  HTTP_BAD_REQUEST,
  nowIso,
  type Db,
  type MfaMethods
} from '@zamfono/shared';

import { loadBranding } from '#lib/server/auth/branding.js';
import { noticeMfaChange } from '#lib/server/auth/mfa/notice.js';
import { qrSvg } from '#lib/server/auth/mfa/qr.js';
import {
  issueRecoveryCodes,
  redeemRecoveryCode
} from '#lib/server/auth/mfa/recoveryCodes.js';
import {
  finishSecondFactorLogin,
  secondFactorLogin,
  startSecondFactorLogin,
  updateSecondFactorLogin,
  type SecondFactorLogin
} from '#lib/server/auth/mfa/secondFactorLogin.js';
import { hasMfa } from '#lib/server/auth/mfa/status.js';
import {
  base32Encode,
  groupedSecret,
  matchTotp,
  newTotpSecret,
  otpauthUri
} from '#lib/server/auth/mfa/totp.js';
import { saveTotp, verifyTotp } from '#lib/server/auth/mfa/totpCredential.js';
import { getDb } from '#lib/server/db.js';
import { limiter } from '#lib/server/limiter.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { completeLogin, type ConsentStep } from './completeLogin.js';

// Any step accepts a code from an authenticator that never signed in before.
const NO_STEP_YET = -1;
const TOTP_CODE = /^\d{6}$/u;

/** The second step's form: a code (authenticator or recovery code) or, once enrolment showed the
 *  recovery codes, the person's confirmation that they saved them. */
export const SecondFactorPayloadSchema = z.object({
  code: z.string().catch(''),
  action: z.enum(['code', 'saved'])
});

export type SecondFactorPayload = z.infer<typeof SecondFactorPayloadSchema>;

/** The second step the page renders (§5.2 "Two-factor authentication"): a code to verify, an
 *  authenticator to set up (its QR code and its secret as text), or the recovery codes enrolment
 *  issued, shown once. `error` is the refusal of the code last submitted. */
export type SecondFactorStep =
  | { step: 'verify'; error: string | null }
  | { step: 'enrol'; qrSvg: string; secret: string; error: string | null }
  | { step: 'recoveryCodes'; codes: string[] };

/** The enrolment step for `secret`: the `otpauth` URI as a QR code, issued by the company name
 *  (else the FQDN) for the e-mail the person signed in with. */
async function enrolStep(
  db: Db,
  login: SecondFactorLogin,
  secret: Buffer,
  refusal: string | null
): Promise<SecondFactorStep> {
  const { companyName } = await loadBranding(db);
  const issuer = companyName === '' ? env.FQDN : companyName;
  return {
    step: 'enrol',
    qrSvg: qrSvg(otpauthUri(issuer, login.email, secret)),
    secret: groupedSecret(base32Encode(secret)),
    error: refusal
  };
}

/**
 * Starts the second step of a sign-in whose password passed: the code of a method `status` holds,
 * or, for a user who must have one and has none, enrolment of an authenticator app (no skip).
 */
export async function beginSecondFactor(
  event: RequestEvent,
  login: Omit<SecondFactorLogin, 'totpSecret' | 'recoveryCodes'>,
  status: MfaMethods
): Promise<SecondFactorStep> {
  if (hasMfa(status)) {
    startSecondFactorLogin(event.cookies, {
      ...login,
      totpSecret: null,
      recoveryCodes: null
    });
    return { step: 'verify', error: null };
  }
  const secret = newTotpSecret();
  const pending = { ...login, totpSecret: secret, recoveryCodes: null };
  startSecondFactorLogin(event.cookies, pending);
  return enrolStep(getDb(), pending, secret, null);
}

/** Confirms the enrolling authenticator with `code`: stores it with fresh recovery codes, which
 *  the next step shows; `null` for a wrong code. */
async function confirmEnrolment(
  event: RequestEvent,
  login: SecondFactorLogin,
  secret: Buffer,
  code: string
): Promise<SecondFactorStep | null> {
  const step = matchTotp(secret, code.trim(), Date.now(), NO_STEP_YET);
  if (step === null) {
    return null;
  }
  const db = getDb();
  const kr = keyringFromEnv(env);
  const now = nowIso();
  const codes = await db.transaction().execute(async trx => {
    await saveTotp(trx, kr, { userId: login.userId, secret, step }, now);
    return issueRecoveryCodes(trx, login.userId, now);
  });
  noticeMfaChange(db, kr, login.userId, { kind: 'added' });
  updateSecondFactorLogin(event.cookies, {
    ...login,
    totpSecret: null,
    recoveryCodes: codes
  });
  return { step: 'recoveryCodes', codes };
}

/** Whether `code` passes the second step for `login`: an authenticator code, else a recovery
 *  code, which it uses up. */
async function codePasses(
  login: SecondFactorLogin,
  code: string
): Promise<boolean> {
  const db = getDb();
  const trimmed = code.trim();
  if (TOTP_CODE.test(trimmed)) {
    return verifyTotp(
      db,
      keyringFromEnv(env),
      login.userId,
      trimmed,
      Date.now()
    );
  }
  return redeemRecoveryCode(db, login.userId, trimmed);
}

/** Ends the pending sign-in and completes the login it was for. */
function finish(event: RequestEvent, login: SecondFactorLogin): ConsentStep {
  limiter.loginSucceeded(login.account);
  finishSecondFactorLogin(event.cookies);
  return completeLogin(event, login.userId, login.client);
}

/**
 * The second step's form (§5.2 "Two-factor authentication", §5.5): every code counts against the
 * account lock as a password does, and a locked account's code is refused like a wrong one; the
 * lock's counter resets only once the whole sign-in has passed. A pending sign-in that expired
 * or finished answers the error page, like a consent step that did.
 */
export async function secondFactorSubmit(
  event: RequestEvent,
  { code, action }: SecondFactorPayload
): Promise<SecondFactorStep | ConsentStep> {
  const login = secondFactorLogin(event.cookies);
  if (login === null) {
    error(HTTP_BAD_REQUEST, 'oauth/authorize: sign-in expired');
  }
  if (login.recoveryCodes !== null) {
    if (action === 'code') {
      return { step: 'recoveryCodes', codes: login.recoveryCodes };
    }
    return finish(event, login);
  }
  const refusal = (await loadBranding(getDb())).dictionary.mfa.invalidCode;
  const counted = limiter.countLoginAttempt(login.account);
  if (login.totpSecret !== null) {
    const next = counted
      ? await confirmEnrolment(event, login, login.totpSecret, code)
      : null;
    return next ?? enrolStep(getDb(), login, login.totpSecret, refusal);
  }
  if (counted && (await codePasses(login, code))) {
    return finish(event, login);
  }
  return { step: 'verify', error: refusal };
}
