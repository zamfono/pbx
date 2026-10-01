import { getDb } from '#lib/db.js';
import { dictionaryFor } from '#lib/i18n/index.js';

import type { LayoutServerLoad } from './$types.js';

const SETTINGS_ROW_ID = 1;

/**
 * Shared by every `/auth/*` page (§5.2 "Authentication pages"): `/auth/error` and `/auth/done`
 * carry no client or token to look anything up from, so this is the one place they get
 * `settings.language`/`settings.company_name` from, the same way `/oauth/authorize` and
 * `/auth/set-password`/`/auth/forgot` do through their own page loads.
 */
export const load: LayoutServerLoad = async () => {
  const db = getDb();
  const settings = await db
    .selectFrom('settings')
    .select(['language', 'companyName'])
    .where('id', '=', SETTINGS_ROW_ID)
    .executeTakeFirstOrThrow();
  return {
    dictionary: dictionaryFor(settings.language),
    companyName: settings.companyName
  };
};
