/**
 * The sign-in between the password and the second factor (§5.2 "Two-factor authentication"):
 * held in `api`'s memory like the authorization codes, for five minutes, and reached only
 * through the random id of the `zamfono_mfa` cookie (HttpOnly), so nothing the browser carries
 * says that the password step passed. An `api` restart voids the logins in flight.
 */
import { randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';

import { MS_PER_SECOND } from '@zamfono/shared';

import { TtlMap } from '#lib/server/ttlMap.js';

import type { PendingAuthorize } from '../ssoCookie.js';

const TTL_S = 300;
const ID_BYTES = 32;
// The cookie reaches the page's remote forms, which post to `/_app/remote/<id>` with JavaScript
// and to the page itself without, so no path narrower than `/` covers both (as `zamfono_consent`).
const COOKIE = { name: 'zamfono_mfa', path: '/' } as const;

/** A sign-in whose password passed: whom it is for, the outer OAuth request it resumes, and
 *  where the person is in enrolment. */
export type SecondFactorLogin = {
  userId: string;
  /** The §5.5 account-lock key, which every code attempt counts against. */
  account: string;
  /** The e-mail the person signed in with, which names the account in their authenticator. */
  email: string;
  /** The outer OAuth request the sign-in resumes and its client's name; `null` for a bare one. */
  client: { authorize: PendingAuthorize; clientName: string } | null;
  /** Enrolment: the authenticator secret awaiting its first code, else `null`. */
  totpSecret: Buffer | null;
  /** The WebAuthn challenge of the passkey options the page shows last, else `null`. */
  challenge: string | null;
  /** Enrolment done: the recovery codes awaiting the person's "saved", else `null`. */
  recoveryCodes: string[] | null;
};

type Entry = { login: SecondFactorLogin; expiresAtMs: number };

const logins = new TtlMap<string, Entry>();

/** Holds `login` and sets the cookie that reaches it. */
export function startSecondFactorLogin(
  cookies: Cookies,
  login: SecondFactorLogin
): void {
  const id = randomBytes(ID_BYTES).toString('base64url');
  const expiresAtMs = Date.now() + TTL_S * MS_PER_SECOND;
  logins.set(id, { login, expiresAtMs }, expiresAtMs);
  cookies.set(COOKIE.name, id, {
    path: COOKIE.path,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: TTL_S
  });
}

/** The pending login the request's cookie reaches, `null` once it expired, finished or never
 *  existed. */
export function secondFactorLogin(cookies: Cookies): SecondFactorLogin | null {
  const id = cookies.get(COOKIE.name);
  return id === undefined ? null : (logins.get(id)?.login ?? null);
}

/** Replaces the request's pending login with `login`, keeping its expiry. */
export function updateSecondFactorLogin(
  cookies: Cookies,
  login: SecondFactorLogin
): void {
  const id = cookies.get(COOKIE.name);
  const entry = id === undefined ? undefined : logins.get(id);
  if (id !== undefined && entry !== undefined) {
    logins.set(
      id,
      { login, expiresAtMs: entry.expiresAtMs },
      entry.expiresAtMs
    );
  }
}

/** Ends the request's pending login: it is single-use. */
export function finishSecondFactorLogin(cookies: Cookies): void {
  const id = cookies.get(COOKIE.name);
  if (id !== undefined) {
    logins.delete(id);
  }
  cookies.delete(COOKIE.name, { path: COOKIE.path });
}
