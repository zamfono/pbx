import { redirect } from '@sveltejs/kit';

import { nowIso } from '@zamfono/shared';

import { hashToken } from '#lib/auth/tokens.js';
import { getDb } from '#lib/db.js';
import { dictionaryFor } from '#lib/i18n/index.js';

import type { PageServerLoad } from './$types.js';

const SETTINGS_ROW_ID = 1;
const STATUS_FOUND = 302;

/**
 * `true` while `token` still redeems (unrevoked, unexpired `reset`-kind row), without consuming
 * it — redemption itself stays with the page's `setPassword` form and `POST /auth/reset` (§5.2
 * "Tokens": single-use).
 */
async function tokenIsLive(token: string): Promise<boolean> {
  const db = getDb();
  const row = await db
    .selectFrom('tokens')
    .select('expiresAt')
    .where('tokenHash', '=', hashToken(token))
    .where('kind', '=', 'reset')
    .where('revokedAt', 'is', null)
    .executeTakeFirst();
  return row !== undefined && row.expiresAt > nowIso();
}

/**
 * `GET /auth/set-password?token=…`: the target of a setup or reset mail link (§5.2, §10.2
 * "Mail"). A missing, expired or already-redeemed token sends the visitor straight to the plain
 * error page (§5.2 "Authentication pages": "an expired link"), rather than showing a form whose
 * submission can only fail; a live token is passed through to the page's `setPassword` form,
 * which redeems it. `?done` is where that form redirects once the password is set, since the
 * link it came from no longer redeems by then: the page renders its confirmation instead.
 */
export const load: PageServerLoad = async event => {
  const db = getDb();
  const settings = await db
    .selectFrom('settings')
    .select(['language', 'companyName'])
    .where('id', '=', SETTINGS_ROW_ID)
    .executeTakeFirstOrThrow();
  const page = {
    dictionary: dictionaryFor(settings.language),
    companyName: settings.companyName
  };
  if (event.url.searchParams.has('done')) {
    return { ...page, token: null, done: true };
  }
  const token = event.url.searchParams.get('token');
  if (token === null || !(await tokenIsLive(token))) {
    redirect(STATUS_FOUND, '/auth/error?reason=expired');
  }
  return { ...page, token, done: false };
};
