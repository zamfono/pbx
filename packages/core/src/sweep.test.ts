import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, openDb, type Db, type Envelope } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { EventBus } from './internal/eventBus.js';
import { ConfigCache } from './internal/snapshot.js';
import { startSweep } from './sweep.js';
import { onEvents } from './testing/busEvents.js';
import { noopLogger } from './testing/pipelineDeps.js';

const SWEEP_INTERVAL_MS = 5;
// A dozen sweep intervals: a transition is picked up, and a repeated emission would show.
const SETTLE_MS = 60;

/** Runs the sweep's faked timers `SETTLE_MS` on, every tick that sets off included. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
}

/** Seeds the settings row and the user/forward-target chain its FKs require. */
async function seedTenant(
  db: Db,
  options: { timezone: string | null }
): Promise<{ forwardTargetId: string }> {
  const userId = newId();
  const forwardTargetId = newId();
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
    .values({ id: forwardTargetId, userId })
    .execute();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+15550001',
      targetId: forwardTargetId,
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
      timezone: options.timezone,
      emergencyNumbersJson: '["112"]'
    })
    .execute();
  return { forwardTargetId };
}

describe('startSweep', () => {
  let sweep: { stop: () => void } | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    sweep?.stop();
    sweep = undefined;
    vi.useRealTimers();
  });

  it("emits an ooo transition only at the tick after the rule's scheduled start", async () => {
    const db = openDb(':memory:');
    await migrateForTest(db);
    const { forwardTargetId } = await seedTenant(db, { timezone: 'UTC' });
    const start = new Date('2026-01-01T00:00:00.000Z');
    const startsAt = new Date('2026-01-01T00:01:00.000Z');
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        startsAt: startsAt.toISOString(),
        expiresAt: null,
        targetId: forwardTargetId,
        createdAt: nowIso()
      })
      .execute();

    let current = start;
    const events: Envelope[] = [];
    const bus = new EventBus();
    onEvents(bus, event => {
      events.push(event);
    });
    sweep = startSweep(
      {
        cache: new ConfigCache(db),
        bus,
        log: noopLogger,
        now: () => current.toISOString(),
        stackTz: 'UTC'
      },
      SWEEP_INTERVAL_MS
    );
    await settle();
    const tenantOoo = (): Envelope[] =>
      events.filter(event => event.type === 'ooo' && event.scope === 'tenant');
    expect(tenantOoo()).toHaveLength(1);
    expect(tenantOoo()[0]).toMatchObject({ scope: 'tenant', active: false });

    current = new Date('2026-01-01T00:01:30.000Z');
    await settle();
    expect(tenantOoo()).toHaveLength(2);
    expect(tenantOoo()[1]).toMatchObject({
      scope: 'tenant',
      active: true,
      startsAt: startsAt.toISOString(),
      expiresAt: null
    });

    current = new Date('2026-01-01T00:02:30.000Z');
    await settle();
    expect(tenantOoo()).toHaveLength(2);
  });

  it('emits an hours transition once when a schedule closes', async () => {
    const db = openDb(':memory:');
    await migrateForTest(db);
    const { forwardTargetId } = await seedTenant(db, { timezone: 'UTC' });
    const openingHoursId = newId();
    await db
      .insertInto('openingHours')
      .values({
        id: openingHoursId,
        closedTargetId: forwardTargetId,
        createdAt: nowIso()
      })
      .execute();
    // 2026-01-05 is a Monday (ISO weekday 1).
    await db
      .insertInto('openingHoursIntervals')
      .values({ openingHoursId, weekday: 1, opens: '09:00', closes: '17:00' })
      .execute();

    let current = new Date('2026-01-05T16:59:00.000Z');
    const events: Envelope[] = [];
    const bus = new EventBus();
    onEvents(bus, event => {
      events.push(event);
    });
    sweep = startSweep(
      {
        cache: new ConfigCache(db),
        bus,
        log: noopLogger,
        now: () => current.toISOString(),
        stackTz: 'UTC'
      },
      SWEEP_INTERVAL_MS
    );
    await settle();
    const tenantHours = (): Envelope[] =>
      events.filter(
        event => event.type === 'hours' && event.scope === 'tenant'
      );
    expect(tenantHours()).toHaveLength(1);
    expect(tenantHours()[0]).toMatchObject({ scope: 'tenant', open: true });

    current = new Date('2026-01-05T17:00:30.000Z');
    await settle();
    expect(tenantHours()).toHaveLength(2);
    expect(tenantHours()[1]).toMatchObject({ scope: 'tenant', open: false });

    current = new Date('2026-01-05T17:01:00.000Z');
    await settle();
    expect(tenantHours()).toHaveLength(2);
  });

  it('evaluates hours in UTC when the stored timezone is no zone Intl knows, instead of skipping every tick', async () => {
    const db = openDb(':memory:');
    await migrateForTest(db);
    const { forwardTargetId } = await seedTenant(db, {
      timezone: 'Mars/Olympus'
    });
    const openingHoursId = newId();
    await db
      .insertInto('openingHours')
      .values({
        id: openingHoursId,
        closedTargetId: forwardTargetId,
        createdAt: nowIso()
      })
      .execute();
    // 2026-01-05 is a Monday (ISO weekday 1).
    await db
      .insertInto('openingHoursIntervals')
      .values({ openingHoursId, weekday: 1, opens: '09:00', closes: '17:00' })
      .execute();
    const events: Envelope[] = [];
    const bus = new EventBus();
    onEvents(bus, event => {
      events.push(event);
    });
    sweep = startSweep(
      {
        cache: new ConfigCache(db),
        bus,
        log: noopLogger,
        now: () => '2026-01-05T16:30:00.000Z',
        stackTz: 'UTC'
      },
      SWEEP_INTERVAL_MS
    );
    await settle();

    const tenantHours = events.filter(
      event => event.type === 'hours' && event.scope === 'tenant'
    );
    expect(tenantHours).toHaveLength(1);
    expect(tenantHours[0]).toMatchObject({ open: true });
  });

  it("evaluates hours in the stack's TZ while settings.timezone is NULL (§11.4)", async () => {
    const db = openDb(':memory:');
    await migrateForTest(db);
    const { forwardTargetId } = await seedTenant(db, { timezone: null });
    const openingHoursId = newId();
    await db
      .insertInto('openingHours')
      .values({
        id: openingHoursId,
        closedTargetId: forwardTargetId,
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('openingHoursIntervals')
      .values({ openingHoursId, weekday: 1, opens: '09:00', closes: '17:00' })
      .execute();
    const events: Envelope[] = [];
    const bus = new EventBus();
    onEvents(bus, event => {
      events.push(event);
    });
    // Monday 10:00 UTC: open in UTC, but 05:00 in New York, before opening time.
    sweep = startSweep(
      {
        cache: new ConfigCache(db),
        bus,
        log: noopLogger,
        now: () => '2026-01-05T10:00:00.000Z',
        stackTz: 'America/New_York'
      },
      SWEEP_INTERVAL_MS
    );
    await settle();

    const tenantHours = events.filter(
      event => event.type === 'hours' && event.scope === 'tenant'
    );
    expect(tenantHours).toHaveLength(1);
    expect(tenantHours[0]).toMatchObject({ open: false });
  });

  // §10.6 `ooo` carries the rule's window: subscribers showing "away until …" must see it move.
  it('emits an ooo event when the running rule is edited or handed over to the next back to back', async () => {
    const db = openDb(':memory:');
    await migrateForTest(db);
    const { forwardTargetId } = await seedTenant(db, { timezone: 'UTC' });
    const ruleId = newId();
    await db
      .insertInto('oooRules')
      .values({
        id: ruleId,
        startsAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T01:00:00.000Z',
        targetId: forwardTargetId,
        createdAt: nowIso()
      })
      .execute();
    let current = '2026-01-01T00:30:00.000Z';
    const events: Envelope[] = [];
    const bus = new EventBus();
    onEvents(bus, event => {
      events.push(event);
    });
    const cache = new ConfigCache(db);
    sweep = startSweep(
      { cache, bus, log: noopLogger, now: () => current, stackTz: 'UTC' },
      SWEEP_INTERVAL_MS
    );
    await settle();
    const tenantOoo = (): Envelope[] =>
      events.filter(event => event.type === 'ooo' && event.scope === 'tenant');
    expect(tenantOoo()).toHaveLength(1);

    // Extended while it runs.
    await db
      .updateTable('oooRules')
      .set({ expiresAt: '2026-01-01T02:00:00.000Z' })
      .where('id', '=', ruleId)
      .execute();
    cache.invalidate();
    await settle();
    expect(tenantOoo()).toHaveLength(2);
    expect(tenantOoo()[1]).toMatchObject({
      active: true,
      startsAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T02:00:00.000Z'
    });

    // A second rule starting as the first expires: active throughout, another window.
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        startsAt: '2026-01-01T02:00:00.000Z',
        expiresAt: null,
        targetId: forwardTargetId,
        createdAt: nowIso()
      })
      .execute();
    cache.invalidate();
    await settle();
    current = '2026-01-01T02:30:00.000Z';
    await settle();
    expect(tenantOoo().slice(2)).toEqual([
      expect.objectContaining({
        active: true,
        startsAt: '2026-01-01T02:00:00.000Z',
        expiresAt: null
      })
    ]);
  });
});
