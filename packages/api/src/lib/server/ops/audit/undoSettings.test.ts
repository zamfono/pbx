import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/server/testDb.js';

import type { TargetSpec } from '../forwardTargetSpec.js';
import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../settings/index.js';
import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    actor: owner,
    channel: 'rest',
    requestId: 'req-1',
    confirm: true,
    ...overrides
  };
}

/** Seeds the tenant `settings` singleton `settings.update` reads. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId
    })
    .execute();
}

async function updateSettings(
  db: Db,
  input: Record<string, unknown>
): Promise<void> {
  await runOperation(db, 'settings.update', input, asRun());
}

/** Undoes the latest live `settings.update` entry. */
async function undoLatestSettingsUpdate(db: Db): Promise<void> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', 'settings.update')
    .where('undoneAt', 'is', null)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  await runOperation(db, 'audit.undo', { id: entry.id }, asRun());
}

async function fallbackTarget(db: Db): Promise<TargetSpec | null> {
  const settings = (await runOperation(db, 'settings.get', {}, asRun())) as {
    fallbackTarget: TargetSpec | null;
  };
  return settings.fallbackTarget;
}

/** Binds a second user by OIDC `sub`, next to the seeded owner. */
async function seedBoundUsers(db: Db): Promise<string> {
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Anna Huber',
      email: 'anna@x.test',
      createdAt: nowIso(),
      ssoSubject: 'sub-anna'
    })
    .execute();
  await db
    .updateTable('users')
    .set({ ssoSubject: 'sub-owner' })
    .where('id', '=', 'owner')
    .execute();
  return userId;
}

async function ssoSubjects(db: Db): Promise<Record<string, string | null>> {
  const rows = await db
    .selectFrom('users')
    .select(['id', 'ssoSubject'])
    .execute();
  return Object.fromEntries(rows.map(row => [row.id, row.ssoSubject]));
}

const OIDC = {
  ssoProvider: 'oidc',
  ssoLabel: 'Corp SSO',
  ssoIssuer: 'https://issuer.example',
  ssoClientId: 'client-1'
};

describe('audit.undo of a settings.update', () => {
  it('restores the tenant fallback target a change replaced (§5.8)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const first: TargetSpec = { kind: 'external', external: '+491111111' };
    await updateSettings(db, { fallbackTarget: first });
    await updateSettings(db, {
      fallbackTarget: { kind: 'external', external: '+492222222' }
    });

    await undoLatestSettingsUpdate(db);
    expect(await fallbackTarget(db)).toEqual(first);

    await undoLatestSettingsUpdate(db);
    expect(await fallbackTarget(db)).toBeNull();
  });

  it('restores the SSO provider and the sso_subject bindings the change cleared (§5.2)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const annaId = await seedBoundUsers(db);
    await updateSettings(db, OIDC);
    // A login under the new issuer re-binds by e-mail (§5.2); the undo clears that binding too.
    await db
      .updateTable('users')
      .set({ ssoSubject: 'sub-new-issuer' })
      .where('id', '=', annaId)
      .execute();

    await undoLatestSettingsUpdate(db);

    const row = await db
      .selectFrom('settings')
      .select(['ssoProvider', 'ssoIssuer', 'ssoClientId', 'ssoLabel'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      ssoProvider: null,
      ssoIssuer: null,
      ssoClientId: null,
      ssoLabel: null
    });
    expect(await ssoSubjects(db)).toMatchObject({
      owner: 'sub-owner',
      [annaId]: 'sub-anna'
    });
  });

  it('restores a switched-off microsoft preset with its jointly required fields', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await updateSettings(db, {
      ssoProvider: 'microsoft',
      ssoClientId: 'client-1',
      ssoTenantId: 'tenant-1'
    });
    const annaId = await seedBoundUsers(db);
    await updateSettings(db, {
      ssoProvider: null,
      ssoClientId: null,
      ssoTenantId: null
    });

    await undoLatestSettingsUpdate(db);

    const row = await db
      .selectFrom('settings')
      .select(['ssoProvider', 'ssoClientId', 'ssoTenantId'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      ssoProvider: 'microsoft',
      ssoClientId: 'client-1',
      ssoTenantId: 'tenant-1'
    });
    expect(await ssoSubjects(db)).toMatchObject({
      owner: 'sub-owner',
      [annaId]: 'sub-anna'
    });
  });

  it('records the undo as the reverse diff, bindings included', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await seedBoundUsers(db);
    await updateSettings(db, OIDC);

    await undoLatestSettingsUpdate(db);

    const undo = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'audit.undo')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(undo.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    const subjects = changes.find(change => change.field === 'ssoSubjects');
    expect(subjects?.from).toEqual([]);
    expect(subjects?.to).toHaveLength(2);
  });
});
