import { afterEach, describe, expect, it } from 'vitest';

import { loginLimiter } from '$lib/server/limiter.js';

import { accountLockedUntil, accountLockKey } from './_accountLock.js';

const LOCK_THRESHOLD = 5;

function lock(account: string): void {
  for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
    loginLimiter.loginFailed(account);
  }
}

describe('accountLockedUntil', () => {
  afterEach(() => {
    loginLimiter.loginSucceeded('a@x.test');
    loginLimiter.loginSucceeded('anna@x.test');
  });

  it("reports the login limiter's own lock as an ISO instant (§5.5)", () => {
    expect(accountLockedUntil('a@x.test')).toBeNull();
    lock('a@x.test');

    const until = accountLockedUntil('a@x.test');
    expect(until).not.toBeNull();
    expect(Number.isNaN(Date.parse(until ?? ''))).toBe(false);
    // The lock is per account: another address is unaffected.
    expect(accountLockedUntil('b@x.test')).toBeNull();
  });

  it('reports the lock for a stored e-mail in any case (§5.5, §11.2 NOCASE)', () => {
    // The login counts failures under the lower-cased key, whatever case was typed.
    lock(accountLockKey('anna@X.test'));

    // The user record reads the lock back with the e-mail as it was stored.
    expect(accountLockedUntil('Anna@x.TEST')).not.toBeNull();
  });
});
