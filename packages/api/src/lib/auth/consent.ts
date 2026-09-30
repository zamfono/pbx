import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';

import { MS_PER_SECOND } from '@zamfono/shared';

import { decrypt, encrypt, type Keyring } from '../secretbox.js';
import { PendingAuthorizeSchema, type PendingAuthorize } from './ssoCookie.js';

/** The `zamfono_consent` cookie's name and `Path`. Only the consent step reads it, but that step
 *  is a remote `form`: a browser running the page's JavaScript submits it to
 *  `/_app/remote/<id>`, and without JavaScript to `/oauth/authorize?/remote=<id>`, so no path
 *  narrower than `/` reaches both. (The SSO cookie keeps `/oauth`: it is read by
 *  `/oauth/callback`, an ordinary GET.) The cookie stays `HttpOnly`, `Secure`, `SameSite=Lax`,
 *  sealed, single-use and 300 s long. */
export const CONSENT_COOKIE_NAME = 'zamfono_consent';
export const CONSENT_COOKIE_PATH = '/';
// The consent step (§5.2 "Authentication pages": "a consent step naming the requesting client")
// only has to survive the round trip to the approve/deny button, so it is far shorter-lived than
// the SSO cookie's 600 s.
const CONSENT_TTL_S = 300;

const PendingConsentSchema = z.object({
  userId: z.string(),
  clientName: z.string(),
  authorize: PendingAuthorizeSchema
});

// The lifetime travels inside the sealed payload, where the client cannot reach it: a cookie's
// own `maxAge` is a request the browser makes, and a replayed cookie value carries none at all.
const SealedConsentSchema = PendingConsentSchema.extend({
  expiresAtS: z.number()
});

/** The authenticated user and outer OAuth request a consent decision is pending for, sealed into
 *  the `zamfono_consent` cookie between the login action and the approve/deny action so neither
 *  carries a client-writable `userId` (§5.2 "Authentication pages": "a consent step naming the
 *  requesting client"). */
export type PendingConsent = z.infer<typeof PendingConsentSchema>;

/** Seals `pending` and sets it as the `zamfono_consent` cookie on `event`'s response. */
export function setConsentCookie(
  event: RequestEvent,
  kr: Keyring,
  pending: { userId: string; clientName: string; authorize: PendingAuthorize }
): void {
  const expiresAtS = Math.floor(Date.now() / MS_PER_SECOND) + CONSENT_TTL_S;
  const sealed = { ...pending, expiresAtS };
  const value = encrypt(kr, JSON.stringify(sealed)).toString('base64url');
  event.cookies.set(CONSENT_COOKIE_NAME, value, {
    path: CONSENT_COOKIE_PATH,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: CONSENT_TTL_S
  });
}

/** Unseals the `zamfono_consent` cookie value; `null` while absent, past the sealed expiry,
 *  sealed under a retired key, or malformed — the approve/deny actions answer every case the
 *  same way, an expired session. */
export function unsealConsent(
  kr: Keyring,
  cookieValue: string | undefined,
  nowMs = Date.now()
): PendingConsent | null {
  if (cookieValue === undefined) {
    return null;
  }
  try {
    const json = decrypt(kr, Buffer.from(cookieValue, 'base64url')).toString(
      'utf8'
    );
    const sealed = SealedConsentSchema.parse(JSON.parse(json));
    if (sealed.expiresAtS * MS_PER_SECOND <= nowMs) {
      return null;
    }
    return {
      userId: sealed.userId,
      clientName: sealed.clientName,
      authorize: sealed.authorize
    };
  } catch {
    return null;
  }
}
