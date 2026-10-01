import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { activeRingotelProvider } from '$lib/server/provisioning/index.js';
import { isProfilePending } from '$lib/server/provisioning/profilePending.js';
import {
  installRingotelFake,
  type RingotelFake
} from '$lib/server/provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '$lib/server/secretbox.js';
import { makeTestDb } from '$lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';

import './index.js';

import { retryPendingProfile } from './profilePush.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: RunInput = {
  actor: { id: 'owner', name: 'Owner', role: 'owner' },
  channel: 'rest',
  requestId: 'req-1'
};

/** The tenant row, set up with Ringotel (`org-1`/`branch-1`), its main DID an external target. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const mainDidId = newId();
  await db
    .insertInto('dids')
    .values({
      id: mainDidId,
      number: '+490000000',
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId,
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key')
    })
    .execute();
}

/** The `ringotel.profile` rows' `outcome`s, oldest first. */
async function profileOutcomes(db: Db): Promise<unknown[]> {
  const rows = await db
    .selectFrom('auditLog')
    .select('changesJson')
    .where('operation', '=', 'ringotel.profile')
    .orderBy('createdAt')
    .execute();
  return rows.map(
    row =>
      (JSON.parse(row.changesJson) as { field: string; to: unknown }[]).find(
        change => change.field === 'outcome'
      )?.to
  );
}

/** The `lang` of every `updateOrganization` sent, in order. */
function organizationLanguages(ringotel: RingotelFake): unknown[] {
  return ringotel.calls
    .filter(call => call.method === 'updateOrganization')
    .map(call => (call.params.params as { lang: unknown }).lang);
}

let fake: RingotelFake | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

describe('settings.ringotel_profile_pending (§10.4 "Tenant profile push", §11.4)', () => {
  it('stays set when Ringotel takes the branch and refuses the organization', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    fake = installRingotelFake();
    fake.failing.add('updateOrganization');

    const result = await runOperation<unknown, { warnings?: string[] }>(
      db,
      'settings.update',
      { language: 'de' },
      owner
    );

    expect(fake.calls.map(call => call.method)).toEqual([
      'updateBranch',
      'updateOrganization'
    ]);
    expect(result.warnings?.[0]).toMatch(/updateOrganization/u);
    expect(await isProfilePending(db)).toBe(true);
    expect(await profileOutcomes(db)).toEqual(['refused']);
  });

  it('is not cleared by a later roster push or re-registration, which carry the branch alone', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    fake = installRingotelFake();
    fake.failing.add('updateOrganization');
    await runOperation(db, 'settings.update', { language: 'de' }, owner);
    fake.failing.delete('updateOrganization');
    fake.calls = [];

    const provider = await activeRingotelProvider(db);
    await provider?.onRosterChanged?.([]);
    await provider?.onPbxRestarted?.();

    expect(fake.calls.map(call => call.method)).not.toContain(
      'updateOrganization'
    );
    expect(await isProfilePending(db)).toBe(true);

    // The retry at the next Asterisk start delivers the organization, and only that clears it.
    await retryPendingProfile(db, 'asterisk.started');

    expect(organizationLanguages(fake)).toEqual(['de']);
    expect(await isProfilePending(db)).toBe(false);
    expect(await profileOutcomes(db)).toEqual(['refused', 'pushed']);
  });

  it('stays set on a retry whose organization part Ringotel refuses again', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    fake = installRingotelFake();
    fake.failing.add('updateOrganization');
    await runOperation(db, 'settings.update', { language: 'de' }, owner);

    await retryPendingProfile(db, 'api.start');

    expect(await isProfilePending(db)).toBe(true);
    expect(await profileOutcomes(db)).toEqual(['refused', 'refused']);
  });

  it('is cleared once Ringotel takes both the branch and the organization', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    fake = installRingotelFake();

    const result = await runOperation<unknown, { warnings?: string[] }>(
      db,
      'settings.update',
      { language: 'de' },
      owner
    );

    expect(result.warnings).toBeUndefined();
    expect(fake.calls.map(call => call.method)).toEqual([
      'updateBranch',
      'updateOrganization'
    ]);
    expect(organizationLanguages(fake)).toEqual(['de']);
    expect(await isProfilePending(db)).toBe(false);
    expect(await profileOutcomes(db)).toEqual(['pushed']);
  });
});
