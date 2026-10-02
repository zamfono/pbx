import type { RequestEvent } from '@sveltejs/kit';

import { redeemPasswordReset } from '#lib/server/auth/passwordReset.js';
import { getDb } from '#lib/server/db.js';
import { problem } from '#lib/server/problem.js';

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;

/**
 * `POST /auth/reset` (§5.2, §10.3): redeems a single-use set-password token and sets the new
 * password (`redeemPasswordReset`, which the set-password page's own form runs too). Outside the
 * §5.5 rate limits: the token itself is the guard.
 */
export async function POST(event: RequestEvent): Promise<Response> {
  const outcome = await redeemPasswordReset(
    getDb(),
    await event.request.json().catch(() => null)
  );
  if (outcome.kind === 'invalidRequest') {
    return problem(STATUS_BAD_REQUEST, 'invalid request');
  }
  if (outcome.kind === 'invalidLink') {
    return problem(STATUS_BAD_REQUEST, 'invalid or expired link');
  }
  return Response.json({ ok: true }, { status: STATUS_OK });
}
