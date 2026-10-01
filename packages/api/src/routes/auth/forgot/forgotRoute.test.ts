import process from 'node:process';
import { isHttpError } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '$lib/server/db.js';

import { load } from './+page.server.js';

process.env.DB_FILE = ':memory:';

async function seedSettings(db: Db, smtpHost: string | null): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, userId: 'owner' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+491234567',
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Acme',
      mainDidId: didId,
      country: 'DE',
      language: 'en',
      emergencyNumbersJson: '["112"]',
      smtpHost
    })
    .execute();
}

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: 'owner',
      name: 'Owner',
      email: 'owner@example.com',
      role: 'owner',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
});

describe('GET /auth/forgot (load)', () => {
  it('404s while settings.smtp_host is NULL (§10.2 "Without a relay")', async () => {
    await seedSettings(getDb(), null);
    const err = await load().catch((caught: unknown) => caught);
    if (!isHttpError(err)) {
      throw new Error('expected an HttpError');
    }
    expect(err.status).toBe(404);
  });
});
