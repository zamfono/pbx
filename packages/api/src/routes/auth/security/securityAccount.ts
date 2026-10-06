/**
 * The security page's signed-in user (§5.2 "Authentication pages") and how a change of their
 * second factors is stored: the rules every management action shares.
 */
import { redirect, type RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import {
  HTTP_SEE_OTHER,
  mfaMethods,
  nowIso,
  type Db,
  type UserRole
} from '@zamfono/shared';

import type { Dictionary } from '#lib/i18n/index.js';
import { mayLogIn } from '#lib/server/auth/loginUser.js';
import {
  noticeMfaChange,
  type MfaChange
} from '#lib/server/auth/mfa/notice.js';
import { issueRecoveryCodes } from '#lib/server/auth/mfa/recoveryCodes.js';
import {
  securitySession,
  type SecuritySession
} from '#lib/server/auth/mfa/securitySession.js';
import { hasMfa, mfaRequired } from '#lib/server/auth/mfa/status.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

const SECURITY_PATH = '/auth/security';

/** What a management action shows: an authenticator awaiting its first code, recovery codes
 *  issued this once, or why it was refused. */
export type ManageResult = {
  totpSetup: { qrSvg: string; secret: string } | null;
  codes: string[] | null;
  error: string | null;
};

export const NOTHING: ManageResult = {
  totpSetup: null,
  codes: null,
  error: null
};

export type SignedIn = {
  session: SecuritySession;
  user: { id: string; email: string; role: UserRole };
};

/**
 * The page's session (§5.2) and its live user, `null` once it expired, the user was deleted or
 * may no longer log in (`mayLogIn`): the page's session is held to the rule every token is.
 */
export async function signedIn(event: RequestEvent): Promise<SignedIn | null> {
  const session = securitySession(event.cookies);
  const user =
    session === null
      ? undefined
      : await getDb()
          .selectFrom('users')
          .select(['id', 'email', 'role', 'passwordHash'])
          .where('id', '=', session.userId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
  if (session === null || user === undefined || !mayLogIn(user)) {
    return null;
  }
  return {
    session,
    user: { id: user.id, email: user.email, role: user.role }
  };
}

/** `signedIn`, sending a browser without a session back to the page's sign-in. */
export async function sessionUser(event: RequestEvent): Promise<SignedIn> {
  const current = await signedIn(event);
  if (current === null) {
    redirect(HTTP_SEE_OTHER, SECURITY_PATH);
  }
  return current;
}

/**
 * Stores the method `store` writes, issuing recovery codes with the user's first method, and
 * mails the user; `null` when `store` refuses.
 */
export async function added(
  db: Db,
  userId: string,
  store: (trx: Db, now: string) => Promise<boolean>,
  change: MfaChange
): Promise<ManageResult | null> {
  const first = !hasMfa(await mfaMethods(db, userId));
  const now = nowIso();
  const outcome = await db.transaction().execute(async trx => {
    if (!(await store(trx, now))) {
      return null;
    }
    return first ? issueRecoveryCodes(trx, userId, now) : [];
  });
  if (outcome === null) {
    return null;
  }
  noticeMfaChange(db, keyringFromEnv(env), userId, change);
  return { ...NOTHING, codes: outcome.length > 0 ? outcome : null };
}

/**
 * Removes a method with `remove`, unless it is the last one of a user who must have one; the
 * recovery codes go with the last method, which they no longer stand in for.
 */
export async function removed(
  user: { id: string; role: UserRole },
  remove: (trx: Db) => Promise<void>,
  change: MfaChange,
  dict: Dictionary['security']
): Promise<ManageResult> {
  const db = getDb();
  const before = await mfaMethods(db, user.id);
  const after = before.passkeys + (before.totp ? 1 : 0) - 1;
  if (after <= 0 && (await mfaRequired(db, user.role))) {
    return { ...NOTHING, error: dict.lastMethod };
  }
  await db.transaction().execute(async trx => {
    await remove(trx);
    if (after <= 0) {
      await trx
        .deleteFrom('recoveryCodes')
        .where('userId', '=', user.id)
        .execute();
    }
  });
  noticeMfaChange(db, keyringFromEnv(env), user.id, change);
  return NOTHING;
}
