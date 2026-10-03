import { newId, type Db } from '@zamfono/shared';

import { makeTestDb, seedTenantTimeZone } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

// Fixtures the statistics tests share (`index.test.ts`, `tenantClock.test.ts`): a tenant on a
// given clock, call rows, and `stats.query` called as the owner. Importing it registers the
// operation.

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

export type QueryOutput = {
  buckets: { start: string; value: number | null }[];
};

/** A test database whose tenant clock is `timezone`. */
export async function makeStatsDb(timezone = 'UTC'): Promise<Db> {
  const db = await makeTestDb();
  await seedTenantTimeZone(db, timezone);
  return db;
}

/** A finished inbound call, ended when it started unless `endedAt` says otherwise. */
export async function insertCall(
  db: Db,
  fields: {
    startedAt: string;
    answeredAt?: string | null;
    endedAt?: string | null;
    status: string;
  }
): Promise<void> {
  await db
    .insertInto('calls')
    .values({
      id: newId(),
      direction: 'inbound',
      fromUri: '+491700000000',
      toUri: '+490000000',
      status: fields.status,
      startedAt: fields.startedAt,
      answeredAt: fields.answeredAt ?? null,
      endedAt: fields.endedAt === undefined ? fields.startedAt : fields.endedAt
    })
    .execute();
}

/** `stats.query` with `input`, as the owner over REST. */
export async function queryStats(
  db: Db,
  input: Record<string, unknown>
): Promise<QueryOutput> {
  return (await runOperation(db, 'stats.query', input, {
    actor: owner,
    channel: 'rest',
    requestId: 'req-1'
  })) as QueryOutput;
}
