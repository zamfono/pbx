import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import {
  installRingotelFake,
  type RingotelFake
} from '#testing/ringotelFake.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { loadSettings } from '../settings/_shared.js';

import './index.js';

process.env.FQDN = 'pbx.example.com';

let fake: RingotelFake | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

/** A stack with a Ringotel API key and no organization yet, and the fake's empty Ringotel. */
async function unsetStack(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db, {
    ringotelApiTokenEnc: encrypt(
      keyringFromEnv(privateEnv),
      'settings.ringotelApiTokenEnc',
      'ringotel-key'
    )
  });
  fake = installRingotelFake([]);
  return db;
}

function setup(db: Db, domain: string): Promise<unknown> {
  return runOperation(
    db,
    'provisioning.ringotelSetup',
    { domain, region: '3', packageid: 1 },
    asRun()
  );
}

describe('provisioning.ringotelSetup while other writes run', () => {
  it('lets one of two setups at once stand and deletes what the other created', async () => {
    const db = await unsetStack();

    const outcomes = await Promise.allSettled([
      setup(db, 'first'),
      setup(db, 'second')
    ]);
    const settings = await loadSettings(db);

    expect(outcomes.map(outcome => outcome.status).sort()).toEqual([
      'fulfilled',
      'rejected'
    ]);
    expect(fake?.organizations.map(org => org.id)).toEqual([
      settings.ringotelOrgId
    ]);
  });

  it('owes the profile push when the settings changed while Ringotel was creating the connection', async () => {
    const db = await unsetStack();
    const fakeFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const { method } = JSON.parse(init?.body as string) as { method: string };
      if (method === 'createBranch') {
        await db
          .updateTable('settings')
          .set({ companyName: 'Renamed' })
          .execute();
      }
      return fakeFetch(url, init);
    }) as typeof fetch;

    await setup(db, 'testco');
    const settings = await loadSettings(db);

    expect(settings.ringotelOrgId).not.toBeNull();
    expect(settings.ringotelProfilePending).toBe(1);
  });
});
