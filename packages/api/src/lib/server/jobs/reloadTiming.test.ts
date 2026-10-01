import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '../testDb.js';
import { nextMaintenanceMoment } from './reloadTiming.js';

// A Wednesday.
const NOW = new Date('2026-09-16T10:00:00Z');

/** An external forward target, the row `ooo_rules.target_id`/`opening_hours.closed_target_id` need. */
async function insertForwardTarget(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  return id;
}

async function insertDid(db: Db, targetId: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('dids')
    .values({
      id,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedSettings(
  db: Db,
  overrides: { timezone?: string; tlsReloadHour?: number } = {}
): Promise<void> {
  const targetId = await insertForwardTarget(db);
  const mainDidId = await insertDid(db, targetId);
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId,
      timezone: overrides.timezone ?? null,
      tlsReloadHour: overrides.tlsReloadHour ?? null
    })
    .execute();
}

async function seedTenantOoo(
  db: Db,
  startsAt: string,
  expiresAt: string
): Promise<void> {
  const targetId = await insertForwardTarget(db);
  await db
    .insertInto('oooRules')
    .values({
      id: newId(),
      scopeUserId: null,
      scopeRingGroupId: null,
      scopeMenuId: null,
      active: 1,
      startsAt,
      expiresAt,
      targetId,
      createdAt: nowIso()
    })
    .execute();
}

async function seedTenantSchedule(
  db: Db,
  intervals: { weekday: number; opens: string; closes: string }[]
): Promise<void> {
  const closedTargetId = await insertForwardTarget(db);
  const id = newId();
  await db
    .insertInto('openingHours')
    .values({
      id,
      scopeUserId: null,
      scopeRingGroupId: null,
      scopeMenuId: null,
      active: 1,
      closedTargetId,
      createdAt: nowIso()
    })
    .execute();
  for (const interval of intervals) {
    // eslint-disable-next-line no-await-in-loop -- a handful of fixture rows, inserted in order
    await db
      .insertInto('openingHoursIntervals')
      .values({ openingHoursId: id, ...interval })
      .execute();
  }
}

const MON_FRI_9_TO_5 = [1, 2, 3, 4, 5].map(weekday => ({
  weekday,
  opens: '09:00',
  closes: '17:00'
}));

describe('nextMaintenanceMoment', () => {
  it('picks the midpoint of a tenant OOO period starting within 7 days', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedTenantOoo(db, '2026-09-18T00:00:00Z', '2026-09-20T00:00:00Z');

    const moment = await nextMaintenanceMoment(db, NOW);

    expect(moment.toISOString()).toBe('2026-09-19T00:00:00.000Z');
  });

  it('falls back to the weekend midpoint of a Mon-Fri opening-hours schedule', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedTenantSchedule(db, MON_FRI_9_TO_5);

    const moment = await nextMaintenanceMoment(db, NOW);

    expect(moment.toISOString()).toBe('2026-09-20T01:00:00.000Z');
  });

  it('falls back to settings.tlsReloadHour when no OOO or schedule applies', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { tlsReloadHour: 4 });

    const moment = await nextMaintenanceMoment(db, NOW);

    expect(moment.toISOString()).toBe('2026-09-17T04:00:00.000Z');
  });

  it('falls back to TLS_RELOAD_HOUR when settings.tlsReloadHour is unset', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    process.env.TLS_RELOAD_HOUR = '5';
    try {
      const moment = await nextMaintenanceMoment(db, NOW);
      expect(moment.toISOString()).toBe('2026-09-17T05:00:00.000Z');
    } finally {
      delete process.env.TLS_RELOAD_HOUR;
    }
  });

  it('falls back to 03:00 when nothing else is configured', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    delete process.env.TLS_RELOAD_HOUR;

    const moment = await nextMaintenanceMoment(db, NOW);

    expect(moment.toISOString()).toBe('2026-09-17T03:00:00.000Z');
  });

  it('resolves a stored timezone Intl cannot use through TZ instead of throwing (§11.4)', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { timezone: 'Mars/Olympus' });
    delete process.env.TLS_RELOAD_HOUR;
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      const moment = await nextMaintenanceMoment(db, NOW);
      // 03:00 in Berlin, on summer time (UTC+2) in September.
      expect(moment.toISOString()).toBe('2026-09-17T01:00:00.000Z');
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });
});
