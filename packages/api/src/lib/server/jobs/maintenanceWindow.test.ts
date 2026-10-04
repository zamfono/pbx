import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import type { Busy } from './maintenanceGiveUp.js';
import {
  createMaintenanceGate,
  IDLE_RECHECK_MS,
  IDLE_WAIT_MS
} from './maintenanceWindow.js';

const BUSY: Busy = {
  liveCalls: 2,
  asteriskChannels: 3,
  recordingsInProgress: 1
};
const BUSY_REASON =
  'live calls 2, Asterisk channels 3, recordings in progress 1';

describe('createMaintenanceGate', () => {
  const saved = { reloadHour: process.env.TLS_RELOAD_HOUR };
  const state: { db?: Db; idle: boolean; asked: number } = {
    idle: true,
    asked: 0
  };

  beforeEach(async () => {
    delete process.env.TLS_RELOAD_HOUR;
    state.idle = true;
    state.asked = 0;
    const db = await makeTestDb();
    await seedSettings(db, { timezone: 'UTC', tlsReloadHour: 3 });
    state.db = db;
  });

  afterEach(() => {
    if (saved.reloadHour !== undefined) {
      process.env.TLS_RELOAD_HOUR = saved.reloadHour;
    }
  });

  function database(): Db {
    if (state.db === undefined) {
      throw new Error('no database');
    }
    return state.db;
  }

  function gate(): ReturnType<typeof createMaintenanceGate> {
    return createMaintenanceGate({
      db: database(),
      work: 'certSync',
      busy: () => {
        state.asked += 1;
        return Promise.resolve(state.idle ? null : BUSY);
      }
    });
  }

  it('stays shut before the moment without asking core, naming the moment', async () => {
    const result = await gate().check(new Date('2026-01-01T01:00:00Z'));

    expect(result).toEqual({
      open: false,
      nextCheckAt: new Date('2026-01-01T03:00:00Z')
    });
    expect(state.asked).toBe(0);
  });

  it('holds the moment it resolved, so a later check past it opens', async () => {
    const shared = gate();
    await shared.check(new Date('2026-01-01T01:00:00Z'));

    await expect(
      shared.check(new Date('2026-01-01T03:00:01Z'))
    ).resolves.toEqual({ open: true });
  });

  it('re-checks every IDLE_RECHECK_MS while busy, then opens once idle', async () => {
    const shared = gate();
    await shared.check(new Date('2026-01-01T01:00:00Z'));
    state.idle = false;
    const atMoment = new Date('2026-01-01T03:00:00Z');

    await expect(shared.check(atMoment)).resolves.toEqual({
      open: false,
      nextCheckAt: new Date(atMoment.getTime() + IDLE_RECHECK_MS)
    });

    state.idle = true;
    await expect(
      shared.check(new Date(atMoment.getTime() + IDLE_RECHECK_MS))
    ).resolves.toEqual({ open: true });
  });

  it('never looks again later than the end of the wait', async () => {
    const shared = gate();
    await shared.check(new Date('2026-01-01T01:00:00Z'));
    state.idle = false;
    const giveUpMs = Date.parse('2026-01-01T03:00:00Z') + IDLE_WAIT_MS;

    await expect(
      shared.check(new Date(giveUpMs - IDLE_RECHECK_MS / 2))
    ).resolves.toEqual({ open: false, nextCheckAt: new Date(giveUpMs) });
  });

  it('gives up IDLE_WAIT_MS past the moment until the next one, idle or not', async () => {
    const shared = gate();
    await shared.check(new Date('2026-01-01T01:00:00Z'));
    state.idle = false;
    await shared.check(new Date('2026-01-01T03:00:00Z'));
    state.idle = true;

    await expect(
      shared.check(new Date(Date.parse('2026-01-01T03:00:00Z') + IDLE_WAIT_MS))
    ).resolves.toEqual({
      open: false,
      nextCheckAt: new Date('2026-01-02T03:00:00Z'),
      gaveUp: { inARow: 1, reason: BUSY_REASON }
    });
    await expect(
      shared.check(new Date('2026-01-02T03:00:00Z'))
    ).resolves.toEqual({ open: true });
  });

  it('records each give-up with what its last look found busy, counts them in a row, and ends the run when it opens', async () => {
    const db = database();
    const shared = gate();
    state.idle = false;
    const giveUpOn = async (day: string): Promise<unknown> => {
      await shared.check(new Date(`${day}T03:00:00Z`));
      return shared.check(
        new Date(Date.parse(`${day}T03:00:00Z`) + IDLE_WAIT_MS)
      );
    };

    await shared.check(new Date('2026-01-01T01:00:00Z'));
    await giveUpOn('2026-01-01');
    await expect(giveUpOn('2026-01-02')).resolves.toMatchObject({
      gaveUp: { inARow: 2, reason: BUSY_REASON }
    });

    expect(
      await db.selectFrom('maintenanceGate').selectAll().execute()
    ).toEqual([
      {
        work: 'certSync',
        gaveUpAt: '2026-01-02T05:00:00.000Z',
        reason: BUSY_REASON,
        consecutiveGiveUps: 2
      }
    ]);
    const entries = await db
      .selectFrom('auditLog')
      .select(['operation', 'channel', 'actorUserId', 'changesJson'])
      .orderBy('id')
      .execute();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      operation: 'system.maintenanceGate',
      channel: 'job',
      actorUserId: 'system'
    });
    expect(
      Object.fromEntries(
        (
          JSON.parse(entries[1]?.changesJson ?? '[]') as {
            field: string;
            to: unknown;
          }[]
        ).map(change => [change.field, change.to])
      )
    ).toEqual({
      work: 'certSync',
      outcome: 'gaveUp',
      moment: '2026-01-02T03:00:00.000Z',
      reason: BUSY_REASON,
      inARow: 2,
      liveCalls: 2,
      asteriskChannels: 3,
      recordingsInProgress: 1
    });

    state.idle = true;
    await expect(
      shared.check(new Date('2026-01-03T03:00:00Z'))
    ).resolves.toEqual({ open: true });
    expect(
      await db.selectFrom('maintenanceGate').selectAll().execute()
    ).toMatchObject([
      { gaveUpAt: '2026-01-02T05:00:00.000Z', consecutiveGiveUps: 0 }
    ]);
  });

  it('records no give-up for a wait in which it never found the system busy', async () => {
    const db = database();
    const shared = gate();
    await shared.check(new Date('2026-01-01T01:00:00Z'));

    await expect(
      shared.check(new Date(Date.parse('2026-01-01T03:00:00Z') + IDLE_WAIT_MS))
    ).resolves.toEqual({
      open: false,
      nextCheckAt: new Date('2026-01-02T03:00:00Z')
    });
    expect(
      await db.selectFrom('maintenanceGate').selectAll().execute()
    ).toEqual([]);
    expect(state.asked).toBe(0);
  });

  it('resolves a fresh moment after opening and after reset', async () => {
    const shared = gate();
    await expect(
      shared.check(new Date('2026-01-01T03:30:00Z'))
    ).resolves.toEqual({
      open: false,
      nextCheckAt: new Date('2026-01-02T03:00:00Z')
    });
    await shared.reset();
    await shared.check(new Date('2026-01-01T02:00:00Z'));
    await expect(
      shared.check(new Date('2026-01-01T03:00:00Z'))
    ).resolves.toEqual({ open: true });
    await expect(
      shared.check(new Date('2026-01-01T03:01:00Z'))
    ).resolves.toEqual({
      open: false,
      nextCheckAt: new Date('2026-01-02T03:00:00Z')
    });
  });
});
