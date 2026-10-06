import { describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import '../audit/index.js';
import './index.js';

const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };

describe('settings: mfaRequiredForAll (§5.2 "Two-factor authentication", §11.4)', () => {
  it('is off by default and switched only by an owner', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(db, 'settings.get', {}, asRun())
    ).resolves.toMatchObject({ mfaRequiredForAll: false });
    await expect(
      runOperation(
        db,
        'settings.update',
        { mfaRequiredForAll: true },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runOperation(db, 'settings.update', { mfaRequiredForAll: true }, asRun())
    ).resolves.toMatchObject({ mfaRequiredForAll: true });
  });
});
