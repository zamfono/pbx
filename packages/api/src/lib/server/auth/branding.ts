import type { Db } from '@zamfono/shared';

import { dictionaryFor, type Dictionary } from '#lib/i18n/index.js';

/** What every authentication page renders with (§5.2 "Authentication pages"): the strings of
 *  `settings.language` and `settings.company_name`, its title. */
export type Branding = { dictionary: Dictionary; companyName: string };

export async function loadBranding(db: Db): Promise<Branding> {
  const settings = await db
    .selectFrom('settings')
    .select(['language', 'companyName'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return {
    dictionary: dictionaryFor(settings.language),
    companyName: settings.companyName
  };
}
