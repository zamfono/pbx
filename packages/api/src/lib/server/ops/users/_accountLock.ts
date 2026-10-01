/**
 * The §5.5 account lock, as the user record reports it. The lock itself lives in `api`'s memory
 * alongside the login limiter's counters, so the operations layer reads it through a lookup the
 * process installs at startup rather than from a column. Without an installed lookup — a job, a
 * test, an `api` that has served no login yet — no account is locked.
 */
export type AccountLockLookup = (
  account: string
) => { until: string } | null | undefined;

/**
 * The key the §5.5 account lock is counted and looked up under: the e-mail, lower-cased.
 * `users.email` is `COLLATE NOCASE` (§11.2), so every case variant names the one account; the login
 * counts failures under this key and the user record reads the lock back under it, whatever case
 * the address was typed or stored in.
 */
export function accountLockKey(email: string): string {
  return email.toLowerCase();
}

// One mutable module slot, held in an object rather than a `let`: ESLint's `init-declarations`
// and `no-undef-init` leave no way to declare an optional `let` binding directly.
const lookupHolder: { current: AccountLockLookup | undefined } = {
  current: undefined
};

/** Installs the lookup that answers from the login limiter's lock table (§5.5), keyed by
 *  `accountLockKey`. */
export function setAccountLockLookup(
  lookup: AccountLockLookup | undefined
): void {
  lookupHolder.current = lookup;
}

/** The ISO instant `email`'s lock expires at, or `null` while the account is not locked (§5.5).
 *  The lookup is asked under `accountLockKey(email)`, the key the login locked it under. */
export function accountLockedUntil(email: string): string | null {
  return lookupHolder.current?.(accountLockKey(email))?.until ?? null;
}
