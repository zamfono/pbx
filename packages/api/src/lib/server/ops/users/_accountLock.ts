/**
 * The §5.5 account lock, as the user record reports it ("an active lock is visible to admins on
 * the user record"). The lock lives in the login limiter's memory, not in a column.
 */
import { loginLimiter } from '#lib/server/limiter.js';

/**
 * The key the §5.5 account lock is counted and looked up under: the e-mail, lower-cased.
 * `users.email` is `COLLATE NOCASE` (§11.2), so every case variant names the one account; the login
 * counts failures under this key and the user record reads the lock back under it, whatever case
 * the address was typed or stored in.
 */
export function accountLockKey(email: string): string {
  return email.toLowerCase();
}

/** The ISO instant `email`'s lock expires at, or `null` while the account is not locked (§5.5). */
export function accountLockedUntil(email: string): string | null {
  const lock = loginLimiter.isLocked(accountLockKey(email));
  return lock.locked ? new Date(lock.until).toISOString() : null;
}
