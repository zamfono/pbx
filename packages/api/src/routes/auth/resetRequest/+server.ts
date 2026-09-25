import type { RequestEvent } from '@sveltejs/kit';

import { requestPasswordReset } from '../../../lib/auth/passwordReset.js';
import { getDb } from '../../../lib/db.js';
import { problem } from '../../../lib/problem.js';

const STATUS_NOT_FOUND = 404;
const STATUS_ACCEPTED = 202;
const STATUS_TOO_MANY_REQUESTS = 429;

/**
 * `POST /auth/resetRequest` (§5.2, §5.5, §10.3): answers identically whether the address exists
 * or not, and 404 while no relay is configured, the same way the forgot-password page is hidden.
 * The forgot-password page's own form runs the same `requestPasswordReset`.
 */
export async function POST(event: RequestEvent): Promise<Response> {
  const outcome = await requestPasswordReset(getDb(), {
    clientAddress: () => event.getClientAddress(),
    body: () => event.request.json().catch(() => null)
  });
  if (outcome.kind === 'noRelay') {
    return problem(STATUS_NOT_FOUND, 'not found');
  }
  if (outcome.kind === 'limited') {
    return problem(STATUS_TOO_MANY_REQUESTS, 'too many requests', undefined, {
      'retry-after': String(outcome.retryAfterS)
    });
  }
  return new Response(null, { status: STATUS_ACCEPTED });
}
