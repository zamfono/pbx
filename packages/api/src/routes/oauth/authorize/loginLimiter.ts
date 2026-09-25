import { error, type RequestEvent } from '@sveltejs/kit';

import { addressKey } from '../../../lib/addressKey.js';
import { Limiter } from '../../../lib/limiter.js';
import { setAccountLockLookup } from '../../../lib/ops/users/_accountLock.js';

const STATUS_TOO_MANY_REQUESTS = 429;

/** The login's limiter (§5.5), one for the process's lifetime: counters reset on an `api`
 *  restart. It holds both of the login's counters, the per-address volume limit and the
 *  per-account lock. */
export const loginLimiter = new Limiter();

// §5.5 "an active lock is visible to admins on the user record": the lock lives in this limiter's
// memory, so this module is the only one that can answer for it, and the operations layer reads it
// through the lookup installed here.
setAccountLockLookup(account => {
  const lock = loginLimiter.isLocked(account);
  return lock.locked ? { until: new Date(lock.until).toISOString() } : null;
});

/**
 * Counts one login submission against the client address (§5.5 "Login | client address | 60
 * attempts per minute"), answering 429 past the limit. Every submission of the login form counts,
 * password and SSO alike, so it runs once before the form tells the two apart; views of the page
 * do not, which is why it lives here rather than in the server hooks' per-path limits.
 */
export function checkLoginAddress(event: RequestEvent): void {
  const limit = loginLimiter.check(
    'loginAddress',
    addressKey(event.getClientAddress())
  );
  if (!limit.ok) {
    error(STATUS_TOO_MANY_REQUESTS, 'too many login attempts');
  }
}
