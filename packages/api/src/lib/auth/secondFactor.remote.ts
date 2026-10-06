import { form, getRequestEvent } from '$app/server';

import { checkLoginAddress } from '#lib/server/auth/loginLimiter.js';
import {
  SecondFactorPayloadSchema,
  secondFactorSubmit
} from '#lib/server/auth/mfa/secondFactorSubmit.js';

/**
 * The second step of a password sign-in (§5.2 "Two-factor authentication"), on the login page and
 * the security page alike: a code, a passkey, enrolment's confirmation or the confirmation that
 * the recovery codes are saved. The pending sign-in it acts on is the server's, reached through
 * the `zamfono_mfa` cookie, so the form carries no client parameters of its own.
 */
export const secondFactor = form(SecondFactorPayloadSchema, async payload => {
  const event = getRequestEvent();
  // A code is a login attempt to §5.5's per-address limit, as either first-step button is.
  checkLoginAddress(event);
  return secondFactorSubmit(event, payload);
});
