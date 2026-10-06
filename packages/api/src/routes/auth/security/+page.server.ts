import * as env from '$app/env/private';

import { mfaMethods } from '@zamfono/shared';

import { ssoInfo } from '#lib/server/auth/authorizeRequest.js';
import {
  listPasskeys,
  registrationOptions
} from '#lib/server/auth/mfa/passkeys.js';
import { issuer } from '#lib/server/auth/mfa/secondFactorSteps.js';
import { updateSecuritySession } from '#lib/server/auth/mfa/securitySession.js';
import { mfaRequired } from '#lib/server/auth/mfa/status.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import type { PageServerLoad } from './$types.js';
import { signedIn } from './securityAccount.js';

/**
 * `GET /auth/security` (§5.2 "Authentication pages"): the sign-in that opens the page, or, while
 * its session lives, the signed-in user's second factors with the passkey options a new one
 * registers against; their challenge becomes the session's.
 */
export const load = (async event => {
  const db = getDb();
  const current = await signedIn(event);
  if (current === null) {
    return {
      manage: null,
      sso: await ssoInfo(db, keyringFromEnv(env))
    };
  }
  const { session, user } = current;
  const options = await registrationOptions(db, user, await issuer());
  updateSecuritySession(event.cookies, {
    ...session,
    challenge: options.challenge
  });
  const methods = await mfaMethods(db, user.id);
  return {
    manage: {
      email: user.email,
      required: await mfaRequired(db, user.role),
      totp: methods.totp,
      passkeys: await listPasskeys(db, user.id),
      recoveryCodesLeft: methods.recoveryCodesLeft,
      passkeyOptions: options
    },
    sso: null
  };
}) satisfies PageServerLoad;
