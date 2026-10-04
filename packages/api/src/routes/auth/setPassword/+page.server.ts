import { redirect } from '@sveltejs/kit';

import { HTTP_FOUND, nowIso } from '@zamfono/shared';

import { liveResetTokenUser } from '#lib/server/auth/tokens.js';
import { getDb } from '#lib/server/db.js';

import type { PageServerLoad } from './$types.js';

/**
 * `GET /auth/setPassword?token=…`: the target of a setup or reset mail link (§5.2, §10.2
 * "Mail"). A missing, expired or already-redeemed token sends the visitor straight to the plain
 * error page (§5.2 "Authentication pages": "an expired link"), rather than showing a form whose
 * submission can only fail; a live token is passed through to the page's `setPassword` form,
 * which redeems it (§5.2 "Tokens": single-use), so this check does not consume it. `?done` is where that form redirects once the password is set, since the
 * link it came from no longer redeems by then: the page renders its confirmation instead.
 */
export const load: PageServerLoad = async event => {
  if (event.url.searchParams.has('done')) {
    return { token: null, done: true };
  }
  const token = event.url.searchParams.get('token');
  if (
    token === null ||
    (await liveResetTokenUser(getDb(), token, nowIso())) === null
  ) {
    redirect(HTTP_FOUND, '/auth/error?reason=expired');
  }
  return { token, done: false };
};
