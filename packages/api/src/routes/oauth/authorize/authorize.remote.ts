import { form, getRequestEvent } from '$app/server';
import { z } from 'zod';

import { approveConsentSubmit, denyConsentSubmit } from './consentSubmit.js';
import { checkLoginAddress } from './loginLimiter.js';
import {
  LoginPayloadSchema,
  loginSubmit,
  type LoginResult
} from './loginSubmit.js';
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

const ConsentPayloadSchema = z.object({
  action: z.enum(['approve', 'deny'])
});

/**
 * The consent step (§5.2 "Authentication pages"): approving mints the authorization code and
 * redirects to the client, denying redirects with the standard `access_denied` error. Both
 * outcomes are a 302 to the client's own `redirect_uri`, so neither returns to this page.
 */
export const consent = form(
  ConsentPayloadSchema,
  async ({ action }): Promise<never> => {
    const event = getRequestEvent();
    if (action === 'deny') {
      return denyConsentSubmit(event);
    }
    return approveConsentSubmit(event);
  }
);
