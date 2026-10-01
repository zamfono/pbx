import { error } from '@sveltejs/kit';

import { dictionaryFor } from '$lib/i18n/index.js';
import { getDb } from '$lib/server/db.js';

import type { PageServerLoad } from './$types.js';

const SETTINGS_ROW_ID = 1;
const STATUS_NOT_FOUND = 404;

/**
 * `GET /auth/forgot`: the forgot-password form (§5.2 "Authentication pages"). §10.2 "Without a
 * relay": the login page offers no forgot-password form while `settings.smtp_host` is unset, so
 * this page 404s the same way `POST /auth/resetRequest` does.
 */
export const load = (async () => {
  const db = getDb();
  const settings = await db
    .selectFrom('settings')
    .select(['language', 'companyName', 'smtpHost'])
    .where('id', '=', SETTINGS_ROW_ID)
    .executeTakeFirstOrThrow();
  if (settings.smtpHost === null) {
    error(
      STATUS_NOT_FOUND,
      'forgot-password is unavailable without a mail relay'
    );
  }
  return {
    dictionary: dictionaryFor(settings.language),
    companyName: settings.companyName
  };
}) satisfies PageServerLoad;
