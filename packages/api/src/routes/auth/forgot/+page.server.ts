import { error } from '@sveltejs/kit';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { relayConfigured } from '#lib/server/auth/passwordReset.js';
import { getDb } from '#lib/server/db.js';

import type { PageServerLoad } from './$types.js';

/**
 * `GET /auth/forgot`: the forgot-password form (§5.2 "Authentication pages"). §10.2 "Without a
 * relay": the login page offers no forgot-password form while `settings.smtp_host` is unset, so
 * this page 404s the same way `POST /auth/resetRequest` does.
 */
export const load = (async () => {
  if (!(await relayConfigured(getDb()))) {
    error(
      HTTP_NOT_FOUND,
      'forgot-password is unavailable without a mail relay'
    );
  }
  return {};
}) satisfies PageServerLoad;
