import * as env from '$app/env/private';

import type { Db } from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { stackDomain, stackOrigin } from '#lib/server/stackAddress.js';

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
  return env.DB_FILE ? getDb() : ctx.db;
}

/**
 * The absolute `https://<FQDN>/auth/set-password?token=` link a setup or reset mail carries (§5.2,
 * §10.2 "Mail"), the path the page is mounted at; throws `OpError(503)` while `FQDN` is unset,
 * since a relative link would not open from a mail client and the admin has nothing usable to
 * pass on either (§10.2 "Without a relay").
 */
export function setupLinkFor(token: string): string {
  const fqdn = stackDomain(env);
  if (fqdn === null) {
    throw new OpError(
      STATUS_SERVICE_UNAVAILABLE,
      'FQDN is not configured for this deployment'
    );
  }
  return `${stackOrigin(fqdn)}${SET_PASSWORD_PATH}?token=${token}`;
}
