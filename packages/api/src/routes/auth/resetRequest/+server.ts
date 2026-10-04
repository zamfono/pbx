import type { RequestEvent } from '@sveltejs/kit';

import {
  HTTP_ACCEPTED,
  HTTP_NOT_FOUND,
  HTTP_TOO_MANY_REQUESTS
} from '@zamfono/shared';

import { requestPasswordReset } from '#lib/server/auth/passwordReset.js';
import { getDb } from '#lib/server/db.js';
import { problem } from '#lib/server/problem.js';
import { readJsonBody } from '#lib/server/requestBody.js';

/**
 * `POST /auth/resetRequest` (§5.2, §5.5, §10.3): answers identically whether the address exists
 * or not, and 404 while no relay is configured, the same way the forgot-password page is hidden.
 * The forgot-password page's own form runs the same `requestPasswordReset`.
 */
export async function POST(event: RequestEvent): Promise<Response> {
  const outcome = await requestPasswordReset(getDb(), {
    clientAddress: () => event.getClientAddress(),
    body: async () => readJsonBody(event.request)
  });
  if (outcome.kind === 'noRelay') {
    return problem(HTTP_NOT_FOUND, 'not found');
  }
  if (outcome.kind === 'limited') {
    return problem(HTTP_TOO_MANY_REQUESTS, 'too many requests', undefined, {
      'retry-after': String(outcome.retryAfterS)
    });
  }
  return new Response(null, { status: HTTP_ACCEPTED });
}
