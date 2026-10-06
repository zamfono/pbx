/**
 * The session of the security page (§5.2 "Authentication pages", "Two-factor authentication"):
 * a fresh sign-in on that page opens it for 10 minutes, and nothing else does, not an OAuth
 * token. It lives in `api`'s memory, reached only through the random id of the HttpOnly
 * `zamfono_security` cookie, and holds the authenticator secret or passkey challenge a setup on
 * the page is waiting to confirm.
 */
import { randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';

import { MS_PER_SECOND } from '@zamfono/shared';

import { TtlMap } from '#lib/server/ttlMap.js';

const TTL_S = 600;
const ID_BYTES = 32;
// Remote forms post to `/_app/remote/<id>` with JavaScript and to the page itself without.
const COOKIE = { name: 'zamfono_security', path: '/' } as const;

export type SecuritySession = {
  userId: string;
  /** An authenticator secret shown for setup, awaiting its first code, else `null`. */
  totpSecret: Buffer | null;
  /** The challenge of the passkey registration options shown last, else `null`. */
  challenge: string | null;
};

type Entry = { session: SecuritySession; expiresAtMs: number };

const sessions = new TtlMap<string, Entry>();

/** Opens the page for `userId`, replacing any session the browser held. */
export function startSecuritySession(cookies: Cookies, userId: string): void {
  const old = cookies.get(COOKIE.name);
  if (old !== undefined) {
    sessions.delete(old);
  }
  const id = randomBytes(ID_BYTES).toString('base64url');
  const expiresAtMs = Date.now() + TTL_S * MS_PER_SECOND;
  sessions.set(
    id,
    { session: { userId, totpSecret: null, challenge: null }, expiresAtMs },
    expiresAtMs
  );
  cookies.set(COOKIE.name, id, {
    path: COOKIE.path,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: TTL_S
  });
}

/** The request's session, `null` once it expired or never existed. */
export function securitySession(cookies: Cookies): SecuritySession | null {
  const id = cookies.get(COOKIE.name);
  return id === undefined ? null : (sessions.get(id)?.session ?? null);
}

/** Replaces the request's session with `session`, keeping its expiry. */
export function updateSecuritySession(
  cookies: Cookies,
  session: SecuritySession
): void {
  const id = cookies.get(COOKIE.name);
  const entry = id === undefined ? undefined : sessions.get(id);
  if (id !== undefined && entry !== undefined) {
    sessions.set(
      id,
      { session, expiresAtMs: entry.expiresAtMs },
      entry.expiresAtMs
    );
  }
}
