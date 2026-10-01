import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { ConfigCache } from '../internal/snapshot.js';
import type { ForwardTarget } from '../routing/targets.js';
import { newCall } from './call.js';
import { applyOooAndHours } from './inboundSchedule.js';
import type { Pipeline } from './pipeline.js';

// The targets the schedule sends a call to, recorded instead of run.
const { runTarget } = vi.hoisted(() => ({
  runTarget: vi.fn<(...args: unknown[]) => Promise<void>>()
}));
vi.mock('./runTarget.js', () => ({ runTarget }));

/**
 * Seeds the settings row with `timezone` and a tenant schedule open Monday 09:00-17:00, returning
 * the schedule's closed target.
 */
async function seedTenantHours(
  db: Db,
  timezone: string | null
): Promise<string> {
  const userId = newId();
  const closedTargetId = newId();
  const didId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Owner',
      email: 'owner@example.com',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('forwardTargets')
    .values({ id: closedTargetId, userId })
    .execute();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+15550001',
      targetId: closedTargetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId: didId,
      country: 'DE',
      timezone,
      emergencyNumbersJson: '["112"]'
    })
    .execute();
  const openingHoursId = newId();
  await db
    .insertInto('openingHours')
    .values({ id: openingHoursId, closedTargetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('openingHoursIntervals')
    .values({ openingHoursId, weekday: 1, opens: '09:00', closes: '17:00' })
    .execute();
  return closedTargetId;
}

/**
 * A stand-in `Pipeline` at the instant `now` in a stack whose `TZ` is `stackTz`, recording the
 * targets `runTarget` is handed.
 */
function stubPipeline(
  now: string,
  stackTz?: string
): {
  pipeline: Pipeline;
  ran: ForwardTarget[];
} {
  const ran: ForwardTarget[] = [];
  runTarget.mockReset();
  runTarget.mockImplementation((...args) => {
    ran.push(args[2] as ForwardTarget);
    return Promise.resolve();
  });
  const pipeline = {
    deps: { now: () => now, stackTz }
  } as unknown as Pipeline;
  return { pipeline, ran };
}

function inboundCall(): ReturnType<typeof newCall> {
  return newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: 'caller-1',
    from: '+15559999',
    to: '+15550001',
    startedAt: nowIso(),
    logLevel: 'events',
    callLogMaxBytes: 1_048_576
  });
}

describe('applyOooAndHours', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('evaluates hours in UTC when the stored timezone is no zone Intl knows, instead of throwing', async () => {
    const closedTargetId = await seedTenantHours(db, 'Mars/Olympus');
    const snapshot = await new ConfigCache(db).get();
    // Monday 18:00 UTC: after closing time in UTC.
    const { pipeline, ran } = stubPipeline('2026-01-05T18:00:00.000Z');

    const ended = await applyOooAndHours(
      pipeline,
      inboundCall(),
      snapshot,
      'tenant'
    );

    expect(ended).toBe(true);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ id: closedTargetId });
  });

  it("evaluates hours in the stack's TZ while settings.timezone is NULL (§11.4)", async () => {
    const closedTargetId = await seedTenantHours(db, null);
    const snapshot = await new ConfigCache(db).get();
    // Monday 10:00 UTC: open in UTC, but 05:00 in New York, before opening time.
    const { pipeline, ran } = stubPipeline(
      '2026-01-05T10:00:00.000Z',
      'America/New_York'
    );

    const ended = await applyOooAndHours(
      pipeline,
      inboundCall(),
      snapshot,
      'tenant'
    );

    expect(ended).toBe(true);
    expect(ran[0]).toMatchObject({ id: closedTargetId });
  });

  it('traces the opening-hours evaluation also when no schedule applies (§7)', async () => {
    await seedTenantHours(db, 'UTC');
    await db.deleteFrom('openingHoursIntervals').execute();
    await db.deleteFrom('openingHours').execute();
    const snapshot = await new ConfigCache(db).get();
    const { pipeline } = stubPipeline('2026-01-05T10:00:00.000Z');
    const call = inboundCall();

    await applyOooAndHours(pipeline, call, snapshot, 'tenant');

    expect(call.log.finish().log).toContain(
      '"event":"hours","scope":"tenant","schedule":null'
    );
  });

  it('prefers settings.timezone over the stack TZ', async () => {
    await seedTenantHours(db, 'UTC');
    const snapshot = await new ConfigCache(db).get();
    const { pipeline, ran } = stubPipeline(
      '2026-01-05T10:00:00.000Z',
      'America/New_York'
    );

    const ended = await applyOooAndHours(
      pipeline,
      inboundCall(),
      snapshot,
      'tenant'
    );

    expect(ended).toBe(false);
    expect(ran).toHaveLength(0);
  });
});
