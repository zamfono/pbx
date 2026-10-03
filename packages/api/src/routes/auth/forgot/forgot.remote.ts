import { error } from '@sveltejs/kit';
import { form, getRequestEvent } from '$app/server';
import { z } from 'zod';

import { HTTP_NOT_FOUND, HTTP_TOO_MANY_REQUESTS } from '@zamfono/shared';

import { requestPasswordReset } from '#lib/server/auth/passwordReset.js';
import { getDb } from '#lib/server/db.js';

// Any submission reaches the handler: `requestPasswordReset` validates the address itself and
// accepts a malformed one exactly like an unknown one (§5.5 "answers identically"), and it counts
// every submission against the per-address limit, as `POST /auth/resetRequest` does.
const ForgotPayloadSchema = z.object({ email: z.string().catch('') });

/**
 * The forgot-password form (§5.2 "Authentication pages", §5.5), over the same
 * `requestPasswordReset` as `POST /auth/resetRequest`: 404 while no relay is configured, 429
 * past the per-address limit, otherwise the same confirmation whether the address has an
 * account or not. A submission without JavaScript posts to the page itself and re-renders it
 * with that confirmation.
 */
export const requestReset = form(
  ForgotPayloadSchema,
  async ({ email }): Promise<{ sent: true }> => {
    const event = getRequestEvent();
    const outcome = await requestPasswordReset(getDb(), {
      clientAddress: () => event.getClientAddress(),
      body: () => Promise.resolve({ email })
    });
    if (outcome.kind === 'noRelay') {
      error(HTTP_NOT_FOUND, 'not found');
    }
    if (outcome.kind === 'limited') {
      error(HTTP_TOO_MANY_REQUESTS, 'too many requests');
    }
    return { sent: true };
  }
);
