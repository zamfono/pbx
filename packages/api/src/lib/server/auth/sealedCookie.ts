/**
 * A short-lived cookie whose value is a payload sealed with the Keyring (§5.4): the `zamfono_sso`
 * pending login (`ssoCookie.ts`) and the `zamfono_consent` pending decision (`consent.ts`). Sealed,
 * the browser can carry it but neither read nor forge it.
 */
import type { Cookies } from '@sveltejs/kit';
import { z } from 'zod';

import { epochSeconds, MS_PER_SECOND } from '@zamfono/shared';

import { attempt } from '../errors.js';
import { tryParseJson } from '../json.js';
import { decrypt, encrypt, type Keyring } from '../secretbox.js';

/** A sealed cookie's name, `Path`, lifetime and payload. */
export type SealedCookie<T extends object> = {
  name: string;
  path: string;
  ttlS: number;
  schema: z.ZodType<T>;
};

// The lifetime travels inside the sealed payload, where the client cannot reach it: a cookie's
// own `Max-Age` is a request the browser makes, and a replayed cookie value carries none at all.
const ExpirySchema = z.object({ expiresAtS: z.number() });

/** Seals `payload`, with its expiry, into `cookie` on the response: HttpOnly, Secure,
 *  SameSite=Lax, expiring with the payload itself. */
export function setSealedCookie<T extends object>(
  cookies: Cookies,
  kr: Keyring,
  cookie: SealedCookie<T>,
  payload: T
): void {
  const expiresAtS = epochSeconds(Date.now()) + cookie.ttlS;
  const sealed = encrypt(
    kr,
    `cookie.${cookie.name}`,
    JSON.stringify({ ...payload, expiresAtS })
  );
  cookies.set(cookie.name, sealed.toString('base64url'), {
    path: cookie.path,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: cookie.ttlS
  });
}

/** The payload `cookie` carries on the request; `null` while it is absent, past its sealed
 *  expiry, sealed under a key no longer in the keyring, or malformed. */
export function unsealCookie<T extends object>(
  cookies: Cookies,
  kr: Keyring,
  cookie: SealedCookie<T>
): T | null {
  const value = cookies.get(cookie.name);
  if (value === undefined) {
    return null;
  }
  const json = attempt(() =>
    decrypt(
      kr,
      `cookie.${cookie.name}`,
      Buffer.from(value, 'base64url')
    ).toString('utf8')
  );
  const sealed = json === undefined ? undefined : tryParseJson(json);
  const expiry = ExpirySchema.safeParse(sealed);
  if (!expiry.success || expiry.data.expiresAtS * MS_PER_SECOND <= Date.now()) {
    return null;
  }
  const payload = cookie.schema.safeParse(sealed);
  return payload.success ? payload.data : null;
}
