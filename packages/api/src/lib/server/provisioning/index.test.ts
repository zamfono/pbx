import * as privateEnv from '$app/env/private';
import { describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { encrypt, keyringFromEnv } from '../secretbox.js';
import { activeRingotelProvider } from './index.js';

describe('activeRingotelProvider', () => {
  it('is null while provisioning.ringotelSetup has not run', async () => {
    const db = await makeTestDb();
    await seedSettings(db);

    expect(await activeRingotelProvider(db)).toBeNull();
  });

  it('is a Ringotel provider once the organization and connection ids are set', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });

    const provider = await activeRingotelProvider(db);

    expect(provider).not.toBeNull();
    expect(typeof provider?.onDeviceCreated).toBe('function');
  });
});
