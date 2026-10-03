import { error, type RequestEvent } from '@sveltejs/kit';

import { HTTP_TOO_MANY_REQUESTS } from '@zamfono/shared';

import { addressKey } from '#lib/server/addressKey.js';
import { limiter } from '#lib/server/limiter.js';

/**
 * Counts one login submission against the client address (§5.5 "Login | client address | 60
 * attempts per minute"), answering 429 past the limit. Every submission of the login form counts,
 * password and SSO alike, so it runs once before the form tells the two apart; views of the page
 * do not, which is why it lives here rather than in the server hooks' per-path limits.
 */
export function checkLoginAddress(event: RequestEvent): void {
  const limit = limiter.check(
    'loginAddress',
    addressKey(event.getClientAddress())
  );
  if (!limit.ok) {
    error(HTTP_TOO_MANY_REQUESTS, 'too many login attempts');
  }
}
