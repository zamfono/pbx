/**
 * When the OOO/hours sweep runs (§3.1 "Events"): at a transition instant exactly, at once after a
 * config change, and at the hourly backstop. Fake timers drive both the clock and the timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MS_PER_HOUR,
  MS_PER_MINUTE,
  newId,
  nowIso,
  type Db,
  type Envelope
} from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { EventBus } from './internal/eventBus.js';
import { ConfigCache } from './internal/snapshot.js';
import { startSweep } from './sweep.js';
import { onEvents } from './testing/busEvents.js';
import { noopLogger } from './testing/pipelineDeps.js';
import { seedDid, seedSettings, seedUser } from './testing/seedRows.js';

const EIGHT_DAYS_MS = 8 * 24 * MS_PER_HOUR;

type Seen = { event: Envelope; atMs: number };

/** Seeds the settings row and the user/forward-target chain its FKs require. */
async function seedTenant(
  db: Db,
  timezone: string
): Promise<{ forwardTargetId: string }> {
  const userId = await seedUser(db, {
    name: 'Owner',
    email: 'owner@example.com'
  });
  const forwardTargetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: forwardTargetId, userId })
    .execute();
  await seedSettings(db, {
    mainDidId: await seedDid(db, '+15550001', forwardTargetId),
    timezone
  });
  return { forwardTargetId };
}

/** A tenant opening-hours schedule open 09:00-17:00 on Mondays. */
async function seedMondayHours(db: Db, closedTargetId: string): Promise<void> {
  const openingHoursId = newId();
  await db
    .insertInto('openingHours')
    .values({ id: openingHoursId, closedTargetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('openingHoursIntervals')
    .values({ openingHoursId, weekday: 1, opens: '09:00', closes: '17:00' })
    .execute();
}

async function insertTenantOoo(
  db: Db,
  targetId: string,
  window: { startsAt: string | null; expiresAt: string | null }
): Promise<void> {
  await db
    .insertInto('oooRules')
    .values({ id: newId(), ...window, targetId, createdAt: nowIso() })
    .execute();
}

describe('startSweep timing', () => {
  let sweep: { stop: () => void } | undefined;
  let db: Db;
  let cache: ConfigCache;
  let seen: Seen[] = [];

  beforeEach(async () => {
    db = await migratedTestDb();
    cache = new ConfigCache(db);
    seen = [];
  });

  afterEach(() => {
    sweep?.stop();
    sweep = undefined;
    vi.useRealTimers();
  });

  /** Fakes the clock at `startIso`, starts the sweep and lets its first run settle. */
  async function start(startIso: string, backstopMs?: number): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(startIso));
    const bus = new EventBus();
    onEvents(bus, event => {
      seen.push({ event, atMs: Date.now() });
    });
    sweep = startSweep(
      {
        cache,
        bus,
        log: noopLogger,
        now: () => new Date().toISOString(),
        stackTz: 'UTC'
      },
      backstopMs
    );
    await vi.advanceTimersByTimeAsync(0);
  }

  const tenant = (type: 'ooo' | 'hours'): Seen[] =>
    seen.filter(({ event }) => event.type === type && event.scope === 'tenant');

  it('emits a closing exactly at the schedule edge, not up to a minute late', async () => {
    const { forwardTargetId } = await seedTenant(db, 'UTC');
    await seedMondayHours(db, forwardTargetId);
    // 2026-01-05 is a Monday.
    // Off the minute, so a minute poll would see the edge 30 s late.
    await start('2026-01-05T16:59:30.000Z');
    expect(tenant('hours').map(({ event }) => event)).toMatchObject([
      { open: true }
    ]);

    await vi.advanceTimersByTimeAsync(MS_PER_MINUTE / 2 - 1);
    expect(tenant('hours')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(tenant('hours')).toHaveLength(2);
    expect(tenant('hours')[1]).toMatchObject({
      event: { open: false },
      atMs: Date.parse('2026-01-05T17:00:00.000Z')
    });
  });

  it("emits an OOO rule's start and end exactly at its startsAt and expiresAt", async () => {
    const { forwardTargetId } = await seedTenant(db, 'UTC');
    await insertTenantOoo(db, forwardTargetId, {
      startsAt: '2026-01-01T10:00:00.000Z',
      expiresAt: '2026-01-01T10:30:00.000Z'
    });
    await start('2026-01-01T09:15:20.000Z');

    await vi.advanceTimersByTimeAsync(45 * MS_PER_MINUTE);
    await vi.advanceTimersByTimeAsync(30 * MS_PER_MINUTE);
    expect(tenant('ooo')).toMatchObject([
      { event: { active: false } },
      {
        event: { active: true, expiresAt: '2026-01-01T10:30:00.000Z' },
        atMs: Date.parse('2026-01-01T10:00:00.000Z')
      },
      {
        event: { active: false },
        atMs: Date.parse('2026-01-01T10:30:00.000Z')
      }
    ]);
  });

  it('re-evaluates at once on a config change and re-arms for the new rule', async () => {
    const { forwardTargetId } = await seedTenant(db, 'UTC');
    await start('2026-01-01T09:00:00.000Z');
    expect(tenant('ooo')).toHaveLength(1);

    // An open-ended rule in effect now: announced as soon as the change arrives, no timer needed.
    await insertTenantOoo(db, forwardTargetId, {
      startsAt: null,
      expiresAt: '2026-01-01T09:05:00.000Z'
    });
    cache.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(tenant('ooo')).toHaveLength(2);
    expect(tenant('ooo')[1]).toMatchObject({
      event: { active: true },
      atMs: Date.parse('2026-01-01T09:00:00.000Z')
    });

    // The timer armed by that re-evaluation ends it exactly at its expiry.
    await vi.advanceTimersByTimeAsync(5 * MS_PER_MINUTE);
    expect(tenant('ooo')[2]).toMatchObject({
      event: { active: false },
      atMs: Date.parse('2026-01-01T09:05:00.000Z')
    });
  });

  it('stops re-evaluating on config changes once stopped', async () => {
    const { forwardTargetId } = await seedTenant(db, 'UTC');
    await start('2026-01-01T09:00:00.000Z');
    sweep?.stop();

    await insertTenantOoo(db, forwardTargetId, {
      startsAt: null,
      expiresAt: null
    });
    cache.invalidate();
    await vi.advanceTimersByTimeAsync(2 * MS_PER_HOUR);
    expect(tenant('ooo')).toHaveLength(1);
  });

  it('opens on the Monday after the spring-forward weekend at 09:00 local summer time', async () => {
    const { forwardTargetId } = await seedTenant(db, 'Europe/Berlin');
    await seedMondayHours(db, forwardTargetId);
    // Saturday 13:00 CET; the clocks go forward on Sunday 2026-03-29. No backstop run in between,
    // so the one timer armed now must already name the right instant.
    await start('2026-03-28T12:00:00.000Z', EIGHT_DAYS_MS);
    const openingMs = Date.parse('2026-03-30T07:00:00.000Z');

    await vi.advanceTimersByTimeAsync(openingMs - Date.now() - 1);
    expect(tenant('hours')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(tenant('hours')[1]).toMatchObject({
      event: { open: true },
      atMs: openingMs
    });
  });

  it('catches a wall-clock jump past an edge at the hourly backstop', async () => {
    const { forwardTargetId } = await seedTenant(db, 'UTC');
    await seedMondayHours(db, forwardTargetId);
    // Monday 00:00, nine hours before opening; the clock then steps forward past it.
    await start('2026-01-05T00:00:00.000Z');
    vi.setSystemTime(new Date('2026-01-05T09:30:00.000Z'));
    expect(tenant('hours')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MS_PER_HOUR);
    expect(tenant('hours')[1]).toMatchObject({ event: { open: true } });
  });

  it('logs a failed sweep and retries it a minute later', async () => {
    const { forwardTargetId } = await seedTenant(db, 'UTC');
    await seedMondayHours(db, forwardTargetId);
    const failure = new Error('database is locked');
    vi.spyOn(cache, 'get').mockRejectedValueOnce(failure);
    const error = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-01-05T00:00:00.000Z'));
    const bus = new EventBus();
    onEvents(bus, event => {
      seen.push({ event, atMs: Date.now() });
    });
    sweep = startSweep({
      cache,
      bus,
      log: { ...noopLogger, error },
      now: () => new Date().toISOString(),
      stackTz: 'UTC'
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(
      { err: failure },
      'ooo/hours sweep failed; retrying in 60 s'
    );
    expect(tenant('hours')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MS_PER_MINUTE);
    expect(tenant('hours')).toHaveLength(1);
  });
});
