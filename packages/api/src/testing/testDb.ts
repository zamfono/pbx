import type { Insertable } from 'kysely';

import { newId, nowIso, type DB, type Db } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import type { RunInput } from '#lib/server/ops/runner.js';
import type { Actor } from '#lib/server/ops/types.js';

/** The `owner` user `makeTestDb` seeds, as the actor operations run as. */
export const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

/** A run of an operation by `owner` over REST, with `overrides` on top. */
export function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** `asRun` with the confirmation a confirm-gated operation asks for already given. */
export function asConfirmedRun(overrides: Partial<RunInput> = {}): RunInput {
  return asRun({ confirm: true, ...overrides });
}

/** An in-memory, migrated database seeded with one `owner` user, for operation tests. */
export async function makeTestDb(): Promise<Db> {
  const db = await migratedTestDb();
  await db
    .insertInto('users')
    .values({
      id: owner.id,
      name: owner.name,
      email: 'owner@x',
      role: owner.role,
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  return db;
}

/** Adds the tenant `settings` singleton, `settings` on top of a main DID `+490000000` that
 * forwards to the same external number; returns the main DID's id. */
export async function seedSettings(
  db: Db,
  settings: Partial<Insertable<DB['settings']>> = {}
): Promise<string> {
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
      mainDidId: didId,
      ...settings
    })
    .execute();
  return didId;
}
