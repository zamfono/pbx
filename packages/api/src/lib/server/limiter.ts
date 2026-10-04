import pino from 'pino';

import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '@zamfono/shared';

import { TtlMap } from './ttlMap.js';

// §5.5: lockouts and limit hits are logged with the account or address.
const logger = pino({ name: 'limiter' });

// §5.5 rate limits: the endpoint's key and the window it counts attempts in.
const LOGIN_ADDRESS_LIMIT = 60;
const TOKEN_LIMIT = 60;
const RESET_ADDRESS_LIMIT = 30;
const REGISTER_LIMIT = 60;

// §5.5 account lock: five failures within this window lock the account for the same duration.
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 900_000;
const ACCOUNT_LOCK_MS = 900_000;

// §5.5 forgot-password: at most this many requests per account per hour.
const RESET_ACCOUNT_LIMIT = 3;

export type LimitKind =
  'loginAddress' | 'token' | 'resetAddress' | 'resetAccount' | 'register';

const CHECK_LIMITS: Record<LimitKind, { max: number; windowMs: number }> = {
  loginAddress: { max: LOGIN_ADDRESS_LIMIT, windowMs: MS_PER_MINUTE },
  token: { max: TOKEN_LIMIT, windowMs: MS_PER_MINUTE },
  resetAddress: { max: RESET_ADDRESS_LIMIT, windowMs: MS_PER_HOUR },
  resetAccount: { max: RESET_ACCOUNT_LIMIT, windowMs: MS_PER_HOUR },
  register: { max: REGISTER_LIMIT, windowMs: MS_PER_MINUTE }
};

type FixedWindow = { start: number; count: number };

type LoginFailureState = { failures: number[]; lockedUntil: number | null };

/**
 * In-memory rate limiter and account lock (§5.5). Counters and locks live only in this
 * process's memory, so a restart clears them; the limits are a brake, not the guarantee.
 */
export class Limiter {
  readonly #now: () => number;
  readonly #windows: TtlMap<string, FixedWindow>;
  readonly #loginFailures: TtlMap<string, LoginFailureState>;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#windows = new TtlMap(now);
    this.#loginFailures = new TtlMap(now);
  }

  /**
   * Counts one attempt of `kind` against `key`'s fixed window, then reports whether it
   * stayed within the limit.
   */
  check(
    kind: LimitKind,
    key: string
  ): { ok: true } | { ok: false; retryAfterS: number } {
    const { max, windowMs } = CHECK_LIMITS[kind];
    const mapKey = `${kind}:${key}`;
    const now = this.#now();
    const win = this.#windows.get(mapKey) ?? { start: now, count: 0 };
    win.count += 1;
    this.#windows.set(mapKey, win, win.start + windowMs);
    if (win.count > max) {
      const retryAfterMs = win.start + windowMs - now;
      const retryAfterS = Math.ceil(retryAfterMs / MS_PER_SECOND);
      logger.warn({ kind, key, retryAfterS }, 'rate limit exceeded');
      return { ok: false, retryAfterS };
    }
    return { ok: true };
  }

  /**
   * Counts one login attempt for `account` as failed before its password is checked, so attempts
   * in flight at the same moment count against the lock together; `loginSucceeded` settles a
   * correct one. Five failures within 15 minutes lock the account for 15 minutes. Answers false,
   * counting nothing, while the account is locked: a locked attempt neither counts nor extends it.
   */
  countLoginAttempt(account: string): boolean {
    const now = this.#now();
    const state = this.#loginFailures.get(account) ?? {
      failures: [],
      lockedUntil: null
    };
    if (state.lockedUntil !== null) {
      return false;
    }
    const cutoff = now - LOGIN_FAILURE_WINDOW_MS;
    const failures = [
      ...state.failures.filter(failedAt => failedAt > cutoff),
      now
    ];
    const locking = failures.length >= LOGIN_FAILURE_LIMIT;
    const lockedUntil = locking ? now + ACCOUNT_LOCK_MS : null;
    // Kept while it locks the account or its latest failure still counts.
    this.#loginFailures.set(
      account,
      { failures: locking ? [] : failures, lockedUntil },
      lockedUntil ?? now + LOGIN_FAILURE_WINDOW_MS
    );
    if (locking) {
      logger.warn({ account, lockedUntil }, 'account locked');
    }
    return true;
  }

  /** Clears `account`'s failure counter and any active lock. */
  loginSucceeded(account: string): void {
    this.#loginFailures.delete(account);
  }

  /** Reports whether `account` is currently locked, and until when. */
  isLocked(
    account: string
  ): { locked: false } | { locked: true; until: number } {
    const until = this.#loginFailures.get(account)?.lockedUntil ?? null;
    return until === null ? { locked: false } : { locked: true, until };
  }
}

/** The limiter (§5.5), one for the process's lifetime: counters reset on an `api` restart. Every
 *  limit counts against it under its own `LimitKind`, and it holds the per-account login lock
 *  the login form counts and the user record reports. */
export const limiter = new Limiter();
