import argon2 from 'argon2';

// §5.5: the login form answers a locked account exactly as it answers a wrong password, so the
// lock reveals nothing about the account's existence. A real hash's `argon2.verify` and this
// constant's both cost one Argon2id pass, so an unknown e-mail and a known one take the same time
// and the response cannot be used to probe which e-mails have accounts. Never a real user's hash.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$nvzFaIZ1abMYgAMZc4Dfbg$L7S6+oBEaTebeKryMWxpoKZobe7Z/TfK204RHZ0Ez2M';

/** Hashes `plain` with Argon2id, for storage in `users.password_hash` (§5.2, §11.2). */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain);
}

/**
 * Verifies `plain` against `hash`, an Argon2id PHC string (§5.2 "Login and SSO"). `false` for a
 * `null` hash (SSO-only user, §5.2 "SSO rules"), never a throw.
 * Every path costs one Argon2id verification, against `DUMMY_HASH` when there is no real hash to
 * check, so the response time never reveals whether `hash` was real (§5.5).
 */
export async function verifyPassword(
  hash: string | null,
  plain: string
): Promise<boolean> {
  if (hash === null) {
    await argon2.verify(DUMMY_HASH, plain);
    return false;
  }
  return argon2.verify(hash, plain);
}
