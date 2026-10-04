import { newId, type CallStatus, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { runOperation } from '#lib/server/ops/runner.js';

import { asRun, makeTestDb } from './testDb.js';

import '#lib/server/ops/stats/index.js';

// Fixtures the statistics tests share (`index.test.ts`, `tenantClock.test.ts`): a tenant on a
// given clock, call rows, and `stats.query` called as the owner. Importing it registers the
// operation.

export type QueryOutput = {
  buckets: { start: string; value: number | null }[];
};

/** A test database whose tenant clock is `timezone`. */
export async function makeStatsDb(timezone = 'UTC'): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db, { timezone });
  return db;
}

/**
 * A finished inbound call, ended when it started unless `endedAt` says otherwise; a top-level
 * call outside any ring group unless `parentCallId` and `ringGroupId` say otherwise. Returns its
 * id.
 */
export async function insertCall(
  db: Db,
  fields: {
    startedAt: string;
    answeredAt?: string | null;
    endedAt?: string | null;
    status: CallStatus;
    answeredByUserId?: string;
    parentCallId?: string;
    ringGroupId?: string;
  }
): Promise<string> {
  const id = newId();
  await db
    .insertInto('calls')
    .values({
      id,
      direction: 'inbound',
      fromUri: '+491700000000',
      toUri: '+490000000',
      status: fields.status,
      startedAt: fields.startedAt,
      answeredAt: fields.answeredAt ?? null,
      endedAt: fields.endedAt === undefined ? fields.startedAt : fields.endedAt,
      answeredByUserId: fields.answeredByUserId ?? null,
      parentCallId: fields.parentCallId ?? null,
      ringGroupId: fields.ringGroupId ?? null
    })
    .execute();
  return id;
}

/** `stats.query` with `input`, as the owner over REST. */
export async function queryStats(
  db: Db,
  input: Record<string, unknown>
): Promise<QueryOutput> {
  return (await runOperation(db, 'stats.query', input, asRun())) as QueryOutput;
}
