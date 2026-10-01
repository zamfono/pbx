import { z } from 'zod';

import type { SealedCookie } from './sealedCookie.js';
import { PendingAuthorizeSchema } from './ssoCookie.js';

const PendingConsentSchema = z.object({
  userId: z.string(),
  clientName: z.string(),
  authorize: PendingAuthorizeSchema
});

/** The authenticated user and outer OAuth request a consent decision is pending for, sealed into
 *  the `zamfono_consent` cookie between the login action and the approve/deny action so neither
 *  carries a client-writable `userId` (§5.2 "Authentication pages": "a consent step naming the
 *  requesting client"). */
export type PendingConsent = z.infer<typeof PendingConsentSchema>;

/** The `zamfono_consent` cookie. Only the consent step reads it, but that step is a remote
 *  `form`: a browser running the page's JavaScript submits it to `/_app/remote/<id>`, and without
 *  JavaScript to `/oauth/authorize?/remote=<id>`, so no path narrower than `/` reaches both. (The
 *  SSO cookie keeps `/oauth`: it is read by `/oauth/callback`, an ordinary GET.) The step only has
 *  to survive the round trip to the approve/deny button, so the cookie lasts 300 s, far shorter
 *  than the SSO cookie's 600 s, and is single-use. */
export const CONSENT_COOKIE: SealedCookie<PendingConsent> = {
  name: 'zamfono_consent',
  path: '/',
  ttlS: 300,
  schema: PendingConsentSchema
};
