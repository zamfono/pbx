import type { Db } from '@zamfono/shared';
import { migratedTestDb, seedUser } from '@zamfono/shared/testDb.js';

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
  await seedUser(db, {
    id: owner.id,
    name: owner.name,
    email: 'owner@x',
    role: owner.role,
    passwordHash: 'x'
  });
  return db;
}
