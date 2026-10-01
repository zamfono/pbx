import pino from 'pino';

import { MS_PER_SECOND } from '@zamfono/shared';

// §5.5: lockouts and limit hits are logged with the account or address.
const logger = pino({ name: 'limiter' });

// §5.5 rate limits: the endpoint's key and the window it counts attempts in.
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
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

// The maps below are swept for expired entries only once they grow past this size.
const SWEEP_THRESHOLD = 1000;

export type LimitKind = 'loginAddress' | 'token' | 'resetAddress' | 'register';

const CHECK_LIMITS: Record<LimitKind, { max: number; windowMs: number }> = {
  loginAddress: { max: LOGIN_ADDRESS_LIMIT, windowMs: MINUTE_MS },
  token: { max: TOKEN_LIMIT, windowMs: MINUTE_MS },
  resetAddress: { max: RESET_ADDRESS_LIMIT, windowMs: HOUR_MS },
  register: { max: REGISTER_LIMIT, windowMs: MINUTE_MS }
};

type FixedWindow = { start: number; count: number; windowMs: number };

type LoginFailureState = { failures: number[]; lockedUntil: number | null };

/** Deletes `map`'s expired entries once it holds more than `SWEEP_THRESHOLD`. */
function sweepExpired<K, V>(
  map: Map<K, V>,
  isExpired: (value: V, key: K) => boolean
): void {
  if (map.size <= SWEEP_THRESHOLD) {
    return;
  }
  for (const [key, value] of map) {
    if (isExpired(value, key)) {
      map.delete(key);
    }
  }
}

/**
 * In-memory rate limiter and account lock (§5.5). Counters and locks live only in this
 * process's memory, so a restart clears them; the limits are a brake, not the guarantee.
 */
export class Limiter {
  readonly #now: () => number;
  readonly #windows = new Map<string, FixedWindow>();
  readonly #loginFailures = new Map<string, LoginFailureState>();
  readonly #resetRequests = new Map<string, FixedWindow>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
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
    sweepExpired(this.#windows, win => now - win.start >= win.windowMs);
    const current = this.#windows.get(mapKey);
    const win =
      current && now - current.start < windowMs
        ? current
        : { start: now, count: 0, windowMs };
    win.count += 1;
    this.#windows.set(mapKey, win);
    if (win.count > max) {
      const retryAfterMs = win.start + windowMs - now;
      const retryAfterS = Math.ceil(retryAfterMs / MS_PER_SECOND);
      logger.warn({ kind, key, retryAfterS }, 'rate limit exceeded');
      return { ok: false, retryAfterS };
    }
    return { ok: true };
  }

  /**
   * Records a failed login for `account`. Five failures within 15 minutes lock the
   * account for 15 minutes; attempts made while locked neither count nor extend it.
   */
  loginFailed(account: string): void {
    const now = this.#now();
    sweepExpired(this.#loginFailures, state => {
      const locked = state.lockedUntil !== null && state.lockedUntil > now;
      const cutoff = now - LOGIN_FAILURE_WINDOW_MS;
      return !locked && !state.failures.some(failedAt => failedAt > cutoff);
    });
    const state = this.#loginFailures.get(account) ?? {
      failures: [],
      lockedUntil: null
    };
    if (state.lockedUntil !== null && state.lockedUntil > now) {
      return;
    }
    const cutoff = now - LOGIN_FAILURE_WINDOW_MS;
    const failures = [
      ...state.failures.filter(failedAt => failedAt > cutoff),
      now
    ];
    const locking = failures.length >= LOGIN_FAILURE_LIMIT;
    const lockedUntil = locking ? now + ACCOUNT_LOCK_MS : null;
    this.#loginFailures.set(account, {
      failures: locking ? [] : failures,
      lockedUntil
    });
    if (locking) {
      logger.warn({ account, lockedUntil }, 'account locked');
    }
  }

  /** Clears `account`'s failure counter and any active lock. */
  loginSucceeded(account: string): void {
    this.#loginFailures.delete(account);
  }

  /** Reports whether `account` is currently locked, and until when. */
  isLocked(
    account: string
  ): { locked: false } | { locked: true; until: number } {
    const state = this.#loginFailures.get(account);
    const now = this.#now();
    if (
      state?.lockedUntil !== null &&
      state?.lockedUntil !== undefined &&
      state.lockedUntil > now
    ) {
      return { locked: true, until: state.lockedUntil };
    }
    return { locked: false };
  }

  /**
   * Counts a forgot-password request for `account`. Reports `true` (send the mail) for
   * up to 3 requests per hour, `false` (drop it silently) beyond that.
   */
  resetRequested(account: string): boolean {
    const now = this.#now();
    sweepExpired(this.#resetRequests, win => now - win.start >= win.windowMs);
    const current = this.#resetRequests.get(account);
    const win =
      current && now - current.start < HOUR_MS
        ? current
        : { start: now, count: 0, windowMs: HOUR_MS };
    win.count += 1;
    this.#resetRequests.set(account, win);
    return win.count <= RESET_ACCOUNT_LIMIT;
  }
}

/** The login's limiter (§5.5), one for the process's lifetime: counters reset on an `api`
 *  restart. It holds both of the login's counters, the per-address volume limit and the
 *  per-account lock, which the login form counts and the user record reports. */
export const loginLimiter = new Limiter();
