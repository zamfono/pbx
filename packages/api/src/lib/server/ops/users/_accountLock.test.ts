import { afterEach, describe, expect, it } from 'vitest';

import { Limiter } from '$lib/server/limiter.js';

import {
  accountLockedUntil,
  accountLockKey,
  setAccountLockLookup
} from './_accountLock.js';

const LOCK_THRESHOLD = 5;

describe('accountLockedUntil', () => {
  afterEach(() => {
    setAccountLockLookup(undefined);
  });

  it('reports no lock while nothing has installed a lookup', () => {
    expect(accountLockedUntil('a@x.test')).toBeNull();
  });

  it("reports the login limiter's own lock as an ISO instant (§5.5)", () => {
    const limiter = new Limiter();
    setAccountLockLookup(email => {
      const lock = limiter.isLocked(email);
      return lock.locked ? { until: new Date(lock.until).toISOString() } : null;
    });

    expect(accountLockedUntil('a@x.test')).toBeNull();
    for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
      limiter.loginFailed('a@x.test');
    }

    const until = accountLockedUntil('a@x.test');
    expect(until).not.toBeNull();
    expect(Number.isNaN(Date.parse(until ?? ''))).toBe(false);
    // The lock is per account: another address is unaffected.
    expect(accountLockedUntil('b@x.test')).toBeNull();
  });

  it('reports the lock for a stored e-mail in any case (§5.5, §11.2 NOCASE)', () => {
    const limiter = new Limiter();
    setAccountLockLookup(account => {
      const lock = limiter.isLocked(account);
      return lock.locked ? { until: new Date(lock.until).toISOString() } : null;
    });
    // The login counts failures under the lower-cased key, whatever case was typed.
    for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
      limiter.loginFailed(accountLockKey('anna@X.test'));
    }

    // The user record reads the lock back with the e-mail as it was stored.
    expect(accountLockedUntil('Anna@x.TEST')).not.toBeNull();
  });
});
