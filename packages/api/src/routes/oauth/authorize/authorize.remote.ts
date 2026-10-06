import { form, getRequestEvent } from '$app/server';
import { z } from 'zod';

import { approveConsentSubmit, denyConsentSubmit } from './consentSubmit.js';
import { checkLoginAddress } from './loginLimiter.js';
import {
  LoginPayloadSchema,
  loginSubmit,
  type LoginResult
} from './loginSubmit.js';
import {
  SecondFactorPayloadSchema,
  secondFactorSubmit
} from './secondFactorSubmit.js';
import { ssoSubmit } from './ssoSubmit.js';

/**
 * The login step (§5.2 "Authentication pages"): one form, two submit buttons, so the password
 * fields and the outer request's hidden client parameters are carried by whichever the person
 * presses. Pressing Enter in a text field submits the first button, which is the password one.
 */
export const login = form(
  LoginPayloadSchema,
  async (payload): Promise<LoginResult> => {
    const event = getRequestEvent();
    // §5.5's per-address login limit counts every submission, whichever button sent it.
    checkLoginAddress(event);
    if (payload.action === 'sso') {
      return ssoSubmit(event, payload);
    }
    return loginSubmit(event, payload);
  }
);

/**
 * The second step of a password sign-in (§5.2 "Two-factor authentication"): an authenticator or
 * recovery code, enrolment's confirming code, or the confirmation that the recovery codes are
 * saved. The pending sign-in it acts on is the server's, reached through the `zamfono_mfa`
 * cookie, so the form carries no client parameters of its own.
 */
export const secondFactor = form(SecondFactorPayloadSchema, async payload => {
  const event = getRequestEvent();
  // A code is a login attempt to §5.5's per-address limit, as either first-step button is.
  checkLoginAddress(event);
  return secondFactorSubmit(event, payload);
});

const ConsentPayloadSchema = z.object({
  action: z.enum(['approve', 'deny']),
  client_id: z.string(),
  code_challenge: z.string()
});

/**
 * The consent step (§5.2 "Authentication pages"): approving mints the authorization code and
 * redirects to the client, denying redirects with the standard `access_denied` error. Both
 * outcomes are a 302 to the client's own `redirect_uri`, so neither returns to this page. The
 * form carries the request it shows, so either acts only on that one.
 */
export const consent = form(
  ConsentPayloadSchema,
  async ({ action, ...shown }): Promise<never> => {
    const event = getRequestEvent();
    if (action === 'deny') {
      return denyConsentSubmit(event, shown);
    }
    return approveConsentSubmit(event, shown);
  }
);
