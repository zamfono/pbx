import { form, getRequestEvent } from '$app/server';
import { z } from 'zod';

import { checkLoginAddress } from '#lib/server/auth/loginLimiter.js';

import {
  ManagePayloadSchema,
  manageSubmit,
  removePasskeySubmit
} from './securityManage.js';
import { securitySignIn, SecuritySignInSchema } from './securitySignIn.js';

/** The security page's fresh sign-in (§5.2 "Authentication pages"): a login attempt to §5.5's
 *  per-address limit like the login page's. */
export const signIn = form(SecuritySignInSchema, async payload => {
  const event = getRequestEvent();
  checkLoginAddress(event);
  return securitySignIn(event, payload);
});

/** The page's management of the signed-in user's own second factors (§5.2). */
export const manage = form(ManagePayloadSchema, async payload =>
  manageSubmit(getRequestEvent(), payload)
);

/** The removal of one of the user's passkeys, one form per passkey. */
export const removePasskey = form(
  z.object({ id: z.string() }),
  async ({ id }) => removePasskeySubmit(getRequestEvent(), id)
);
