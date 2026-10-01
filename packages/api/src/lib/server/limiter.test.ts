import { describe, expect, it } from 'vitest';

import { Limiter } from './limiter.js';

describe('Limiter.check', () => {
  it('allows 60 checks per minute and rejects the 61st with a retry time', () => {
    const limiter = new Limiter(() => 0);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect(limiter.check('loginAddress', '203.0.113.7')).toEqual({
        ok: true
      });
    }
    const blocked = limiter.check('loginAddress', '203.0.113.7');
    if (blocked.ok) {
      throw new Error('expected the 61st check to be rate limited');
    }
    expect(blocked.retryAfterS).toBe(60);
  });

  it.each([
    ['loginAddress', 60],
    ['token', 60],
    ['resetAddress', 30],
    ['register', 60]
  ] as const)(
    'allows exactly %s’s per-window limit of %i and rejects one more',
    (kind, max) => {
      const limiter = new Limiter(() => 0);
      for (let attempt = 0; attempt < max; attempt += 1) {
        expect(limiter.check(kind, 'key')).toEqual({ ok: true });
      }
      const blocked = limiter.check(kind, 'key');
      expect(blocked.ok).toBe(false);
    }
  );

  it('resets the window once it has elapsed', () => {
    let now = 0;
    const limiter = new Limiter(() => now);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect(limiter.check('loginAddress', '203.0.113.7')).toEqual({
        ok: true
      });
    }
    expect(limiter.check('loginAddress', '203.0.113.7').ok).toBe(false);
    now = 60_000;
    expect(limiter.check('loginAddress', '203.0.113.7')).toEqual({ ok: true });
  });
});

describe('Limiter account lock', () => {
  it('locks the account after five failed logins within 15 minutes', () => {
    const limiter = new Limiter(() => 0);
    const account = 'ops@example.com';
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    expect(limiter.isLocked(account)).toEqual({ locked: true, until: 900_000 });
  });

  it('does not extend the lock when a further failure arrives while still locked', () => {
    let now = 0;
    const limiter = new Limiter(() => now);
    const account = 'ops@example.com';
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    const firstLock = limiter.isLocked(account);
    if (!firstLock.locked) {
      throw new Error('expected the account to be locked');
    }
    now = 1000;
    limiter.loginFailed(account);
    expect(limiter.isLocked(account)).toEqual({
      locked: true,
      until: firstLock.until
    });
  });

  it('releases the lock once it has expired and starts the counter fresh', () => {
    let now = 0;
    const limiter = new Limiter(() => now);
    const account = 'ops@example.com';
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    now = 900_000;
    expect(limiter.isLocked(account)).toEqual({ locked: false });
    limiter.loginFailed(account);
    expect(limiter.isLocked(account)).toEqual({ locked: false });
  });

  it('clears the counter and lock on a successful login', () => {
    const limiter = new Limiter(() => 0);
    const account = 'ops@example.com';
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginFailed(account);
    limiter.loginSucceeded(account);
    expect(limiter.isLocked(account)).toEqual({ locked: false });
  });
});

describe('Limiter.resetRequested', () => {
  it('allows three requests per hour and drops the fourth', () => {
    const limiter = new Limiter(() => 0);
    const account = 'reset@example.com';
    expect(limiter.resetRequested(account)).toBe(true);
    expect(limiter.resetRequested(account)).toBe(true);
    expect(limiter.resetRequested(account)).toBe(true);
    expect(limiter.resetRequested(account)).toBe(false);
  });
});
