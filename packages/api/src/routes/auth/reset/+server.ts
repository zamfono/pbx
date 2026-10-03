import type { RequestEvent } from '@sveltejs/kit';

import { HTTP_BAD_REQUEST, HTTP_OK } from '@zamfono/shared';

import { redeemPasswordReset } from '#lib/server/auth/passwordReset.js';
import { getDb } from '#lib/server/db.js';
import { tryReadJson } from '#lib/server/json.js';
import { problem } from '#lib/server/problem.js';

/**
 * `POST /auth/reset` (§5.2, §10.3): redeems a single-use set-password token and sets the new
 * password (`redeemPasswordReset`, which the set-password page's own form runs too). Outside the
 * §5.5 rate limits: the token itself is the guard.
 */
export async function POST(event: RequestEvent): Promise<Response> {
  const outcome = await redeemPasswordReset(
    getDb(),
    await tryReadJson(event.request)
  );
  if (outcome.kind === 'invalidRequest') {
    return problem(HTTP_BAD_REQUEST, 'invalid request');
  }
  if (outcome.kind === 'invalidLink') {
    return problem(HTTP_BAD_REQUEST, 'invalid or expired link');
  }
  return Response.json({ ok: true }, { status: HTTP_OK });
}
