import { describe, expect, it } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import { makeTestDb, seedTenantTimeZone } from '../testDb.js';
import { loadBranding } from './branding.js';

describe('loadBranding', () => {
  it("carries the tenant's company name and the dictionary of its language", async () => {
    const db = await makeTestDb();
    await seedTenantTimeZone(db, 'Europe/Berlin');
    await db.updateTable('settings').set({ language: 'de' }).execute();
    expect(await loadBranding(db)).toEqual({
      dictionary: dictionaryFor('de'),
      companyName: 'Test'
    });
  });
});
