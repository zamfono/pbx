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
import {
  noticeMfaChange,
  type MfaChange
} from '#lib/server/auth/mfa/notice.js';
import {
  registerPasskey,
  verifyPasskey
} from '#lib/server/auth/mfa/passkeys.js';
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
import { matchTotp, newTotpSecret } from '#lib/server/auth/mfa/totp.js';
import { saveTotp, verifyTotp } from '#lib/server/auth/mfa/totpCredential.js';
import { getDb } from '#lib/server/db.js';
import { limiter } from '#lib/server/limiter.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { completeLogin, type ConsentStep } from './completeLogin.js';
import {
  enrolStep,
  verifyStep,
  type SecondFactorStep
} from './secondFactorSteps.js';

// Any step accepts a code from an authenticator that never signed in before.
const NO_STEP_YET = -1;
const TOTP_CODE = /^\d{6}$/u;
const MAX_PASSKEY_NAME = 100;

/** The second step's form: a code (authenticator or recovery code), a passkey's response from
 *  the browser (with the name a new one is given), or, once enrolment showed the recovery codes,
 *  the person's confirmation that they saved them. */
export const SecondFactorPayloadSchema = z.object({
  code: z.string().catch(''),
  passkey: z.string().catch(''),
  passkeyName: z.string().catch(''),
  action: z.enum(['code', 'passkey', 'saved'])
});

export type SecondFactorPayload = z.infer<typeof SecondFactorPayloadSchema>;

export type { SecondFactorStep } from './secondFactorSteps.js';

/**
 * Starts the second step of a sign-in whose password passed: a method `status` holds, or, for a
 * user who must have one and has none, the enrolment of an authenticator app or a passkey (no
 * skip).
 */
export async function beginSecondFactor(
  event: RequestEvent,
  login: Pick<SecondFactorLogin, 'userId' | 'account' | 'email' | 'client'>,
  status: MfaMethods
): Promise<SecondFactorStep> {
  const pending = {
    ...login,
    totpSecret: hasMfa(status) ? null : newTotpSecret(),
    challenge: null,
    recoveryCodes: null
  };
  startSecondFactorLogin(event.cookies, pending);
  return pending.totpSecret === null
    ? verifyStep(event, pending, null)
    : enrolStep(event, { ...pending, totpSecret: pending.totpSecret }, null);
}

/** Stores the method `store` writes with fresh recovery codes, which the next step shows, and
 *  mails the user. */
async function enrolled(
  event: RequestEvent,
  login: SecondFactorLogin,
  store: (trx: Db, now: string) => Promise<boolean>,
  change: MfaChange
): Promise<SecondFactorStep | null> {
  const db = getDb();
  const now = nowIso();
  const codes = await db
    .transaction()
    .execute(async trx =>
      (await store(trx, now))
        ? issueRecoveryCodes(trx, login.userId, now)
        : null
    );
  if (codes === null) {
    return null;
  }
  noticeMfaChange(db, keyringFromEnv(env), login.userId, change);
  updateSecondFactorLogin(event.cookies, {
    ...login,
    totpSecret: null,
    challenge: null,
    recoveryCodes: codes
  });
  return { step: 'recoveryCodes', codes };
}

/** Sets up the method the enrolment step's form submitted; `null` when it does not verify. */
async function confirmEnrolment(
  event: RequestEvent,
  login: SecondFactorLogin & { totpSecret: Buffer },
  payload: SecondFactorPayload,
  defaultName: string
): Promise<SecondFactorStep | null> {
  const { userId, totpSecret: secret, challenge } = login;
  if (payload.action === 'passkey') {
    const name =
      payload.passkeyName.trim().slice(0, MAX_PASSKEY_NAME) || defaultName;
    return challenge === null
      ? null
      : enrolled(
          event,
          login,
          async (trx, now) =>
            registerPasskey(
              trx,
              { userId, challenge, name },
              payload.passkey,
              now
            ),
          { kind: 'added', passkeyName: name }
        );
  }
  const step = matchTotp(secret, payload.code.trim(), Date.now(), NO_STEP_YET);
  if (step === null) {
    return null;
  }
  const kr = keyringFromEnv(env);
  return enrolled(
    event,
    login,
    async (trx, now) => {
      await saveTotp(trx, kr, { userId, secret, step }, now);
      return true;
    },
    { kind: 'added' }
  );
}

/** Whether the verify step's submission passes for `login`: a passkey, an authenticator code,
 *  else a recovery code, which it uses up. */
async function passes(
  login: SecondFactorLogin,
  payload: SecondFactorPayload
): Promise<boolean> {
  const db = getDb();
  if (payload.action === 'passkey') {
    return (
      login.challenge !== null &&
      verifyPasskey(
        db,
        login.userId,
        { challenge: login.challenge, responseJson: payload.passkey },
        nowIso()
      )
    );
  }
  const code = payload.code.trim();
  if (TOTP_CODE.test(code)) {
    return verifyTotp(db, keyringFromEnv(env), login.userId, code, Date.now());
  }
  return redeemRecoveryCode(db, login.userId, code);
}

/** Ends the pending sign-in and completes the login it was for. */
function finish(event: RequestEvent, login: SecondFactorLogin): ConsentStep {
  limiter.loginSucceeded(login.account);
  finishSecondFactorLogin(event.cookies);
  return completeLogin(event, login.userId, login.client);
}

/**
 * The second step's form (§5.2 "Two-factor authentication", §5.5): every code or passkey counts
 * against the account lock as a password does, and a locked account's is refused like a wrong
 * one; the lock's counter resets only once the whole sign-in has passed. A pending sign-in that
 * expired or finished answers the error page, like a consent step that did.
 */
export async function secondFactorSubmit(
  event: RequestEvent,
  payload: SecondFactorPayload
): Promise<SecondFactorStep | ConsentStep> {
  const login = secondFactorLogin(event.cookies);
  if (login === null) {
    error(HTTP_BAD_REQUEST, 'oauth/authorize: sign-in expired');
  }
  if (login.recoveryCodes !== null) {
    return payload.action === 'saved'
      ? finish(event, login)
      : { step: 'recoveryCodes', codes: login.recoveryCodes };
  }
  const { mfa } = (await loadBranding(getDb())).dictionary;
  const refusal =
    payload.action === 'passkey' ? mfa.passkeyFailed : mfa.invalidCode;
  const counted = limiter.countLoginAttempt(login.account);
  const { totpSecret } = login;
  if (totpSecret !== null) {
    const enrolling = { ...login, totpSecret };
    const next = counted
      ? await confirmEnrolment(
          event,
          enrolling,
          payload,
          mfa.passkeyDefaultName
        )
      : null;
    return next ?? enrolStep(event, enrolling, refusal);
  }
  if (counted && (await passes(login, payload))) {
    return finish(event, login);
  }
  return verifyStep(event, login, refusal);
}
