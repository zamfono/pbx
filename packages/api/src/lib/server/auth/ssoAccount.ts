import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { mayLogIn } from './loginUser.js';

const logger = pino({ name: 'sso' });

const NO_ROWS_UPDATED = 0n;

/** The account an SSO login resolves to, or why none does (§5.2 "SSO rules"). */
export type SsoAccountResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: 'noUser' | 'unverifiedEmail' | 'subMismatch' | 'noPassword';
    };

/** A matched user `mayLogIn` refuses: an owner who has not set their password yet (§5.2). */
const NO_PASSWORD: SsoAccountResult = { ok: false, reason: 'noPassword' };

/** What an SSO login's checked `id_token` says about the person: `email` is `null` when it
 *  carries none, `emailVouched` whether the issuer vouches for it (§5.2 "SSO rules"). */
export type SsoClaims = {
  sub: string;
  email: string | null;
  emailVouched: boolean;
};

/**
 * Matches `claims` against `users` (§5.2 "SSO rules"): a bound `sso_subject` wins outright,
 * whatever the e-mail; otherwise only a vouched e-mail counts, and an unbound live user with that
 * e-mail is bound to `sub` on first login; an e-mail already bound to a different `sub` is refused
 * and logged, never silently re-bound. A matched user `mayLogIn` refuses is `noPassword`, unbound.
 *
 * The select-then-bind runs in one transaction, and the bind's own `WHERE` re-checks
 * `sso_subject IS NULL` rather than trusting the `SELECT` above it: `users_sso_subject` is a
 * unique index (§11.2), and a concurrent first login may bind the row between the `SELECT` and
 * the `UPDATE`. Losing that race updates no row and is thrown as a failure the person retries,
 * rather than binding over the winner or surfacing as a raw UNIQUE violation.
 */
export async function matchSsoAccount(
  db: Db,
  { sub, email, emailVouched }: SsoClaims
): Promise<SsoAccountResult> {
  return db.transaction().execute(async trx => {
    const bySub = await trx
      .selectFrom('users')
      .select(['id', 'role', 'passwordHash'])
      .where('ssoSubject', '=', sub)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (bySub) {
      return mayLogIn(bySub) ? { ok: true, userId: bySub.id } : NO_PASSWORD;
    }
    if (email === null) {
      return { ok: false, reason: 'noUser' };
    }
    if (!emailVouched) {
      return { ok: false, reason: 'unverifiedEmail' };
    }
    const unbound = await trx
      .selectFrom('users')
      .select(['id', 'role', 'passwordHash'])
      .where('email', '=', email)
      .where('ssoSubject', 'is', null)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (unbound) {
      if (!mayLogIn(unbound)) {
        return NO_PASSWORD;
      }
      const { numUpdatedRows } = await trx
        .updateTable('users')
        .set({ ssoSubject: sub })
        .where('id', '=', unbound.id)
        .where('ssoSubject', 'is', null)
        .executeTakeFirst();
      if (numUpdatedRows === NO_ROWS_UPDATED) {
        throw new Error(
          `sso: lost the bind race for user ${unbound.id}; the login should be retried`
        );
      }
      return { ok: true, userId: unbound.id };
    }
    const boundToOther = await trx
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (boundToOther) {
      logger.warn({ userId: boundToOther.id, sub }, 'sso: sub mismatch');
      return { ok: false, reason: 'subMismatch' };
    }
    return { ok: false, reason: 'noUser' };
  });
}
