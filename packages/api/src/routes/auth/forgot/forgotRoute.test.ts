import process from 'node:process';
import { isHttpError } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '#lib/server/db.js';
import { seedSettings } from '#testing/testDb.js';

import { load } from './+page.server.js';

process.env.DB_FILE = ':memory:';

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
    await seedSettings(getDb(), {
      companyName: 'Acme',
      language: 'en',
      smtpHost: null
    });
    const err = await load().catch((caught: unknown) => caught);
    if (!isHttpError(err)) {
      throw new Error('expected an HttpError');
    }
    expect(err.status).toBe(404);
  });
});
