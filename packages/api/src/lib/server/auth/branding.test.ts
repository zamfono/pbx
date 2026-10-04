import { describe, expect, it } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';
import { makeTestDb, seedSettings } from '#testing/testDb.js';

import { loadBranding } from './branding.js';

describe('loadBranding', () => {
  it("carries the tenant's company name and the dictionary of its language", async () => {
    const db = await makeTestDb();
    await seedSettings(db, { language: 'de' });
    expect(await loadBranding(db)).toEqual({
      dictionary: dictionaryFor('de'),
      companyName: 'Test Co'
    });
  });
});
