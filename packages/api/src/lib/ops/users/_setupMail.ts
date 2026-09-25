import type { Db } from '@zamfono/shared';

import { getDb } from '../../db.js';
import { OpError, type Context } from '../types.js';

const STATUS_SERVICE_UNAVAILABLE = 503;
const SET_PASSWORD_PATH = '/auth/set-password';

/**
 * The pooled `Db` a fire-and-forget mail send should use, never the operation's own transaction
 * handle: that transaction commits as soon as `run` returns, before an unawaited `sendMail` gets
 * to run its queries (§10.3 "Operations layer"). Falls back to `ctx.db` where no process-wide
 * pool is configured (`DB_FILE` unset), which is only the case in tests that call the operation
 * directly against an isolated `makeTestDb()` instance and never await the mail send anyway.
 */
export function mailDb(ctx: Context): Db {
  return process.env.DB_FILE ? getDb() : ctx.db;
}

/**
 * The absolute `<ORIGIN>/auth/set-password?token=` link a setup or reset mail carries (§5.2,
 * §10.2 "Mail"), the path the page is mounted at; throws `OpError(503)` while `ORIGIN` is unset,
 * since a relative link would not open from a mail client and the admin has nothing usable to
 * pass on either (§10.2 "Without a relay").
 */
export function setupLinkFor(token: string): string {
  const origin = process.env.ORIGIN;
  if (!origin) {
    throw new OpError(
      STATUS_SERVICE_UNAVAILABLE,
      'ORIGIN is not configured for this deployment'
    );
  }
  return `${origin}${SET_PASSWORD_PATH}?token=${token}`;
}
