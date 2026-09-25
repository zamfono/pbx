import { getDb } from '../../../lib/db.js';
import { dictionaryFor } from '../../../lib/i18n/index.js';
import type { LayoutServerLoad } from './$types.js';

const SETTINGS_ROW_ID = 1;

/**
 * `settings.language`/`settings.company_name` for `+error.svelte` (§5.2 "Authentication pages":
 * the plain error page for a rejected `redirect_uri` still renders in one design, in the tenant's
 * language, with the company name as its title). A layout load runs independently of the page
 * load next to it, so this still resolves when `+page.server.ts`'s own `load` throws.
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
