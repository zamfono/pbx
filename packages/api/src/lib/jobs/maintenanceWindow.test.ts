import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db, type StateResponse } from '@zamfono/shared';

import { makeTestDb } from '../testDb.js';
import {
  coreIsIdle,
  createMaintenanceGate,
  IDLE_RECHECK_MS,
  IDLE_WAIT_MS,
  isIdleState
} from './maintenanceWindow.js';

const IDLE: StateResponse = {
  calls: [],
  trunks: {},
  trunkChannels: {},
  presence: {},
  registeredDevices: 4,
  recordingMixFailures: 0,
  asteriskChannels: 0,
  recordingsInProgress: 0
};

/** The settings row with the 03:00 quiet hour, the only moment these tests need. */
async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const mainDidId = newId();
  await db
    .insertInto('dids')
    .values({
      id: mainDidId,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId,
      timezone: 'UTC',
      tlsReloadHour: 3
    })
    .execute();
}

describe('isIdleState', () => {
  it('is idle with no call, no channel and no recording; registered devices do not count', () => {
    expect(isIdleState(IDLE)).toBe(true);
  });

  it.each([
    ['a live call', { calls: [{} as StateResponse['calls'][number]] }],
    [
      'a channel only Asterisk holds, such as a parked party',
      { asteriskChannels: 1 }
    ],
    ['a recording still being mixed', { recordingsInProgress: 1 }],
    ['ARI not answering', { asteriskChannels: null }]
  ])('is busy with %s', (_label, overrides) => {
    expect(isIdleState({ ...IDLE, ...overrides })).toBe(false);
  });

  it('is busy for a core that does not report its channels', () => {
    const older: Partial<StateResponse> = { ...IDLE };
    delete older.asteriskChannels;
    expect(isIdleState(older as StateResponse)).toBe(false);
  });
});

describe('coreIsIdle', () => {
  it('is busy while core does not answer', async () => {
    await expect(
      coreIsIdle({ state: () => Promise.reject(new Error('down')) })
    ).resolves.toBe(false);
  });

  it('reads the live state', async () => {
    await expect(
      coreIsIdle({ state: () => Promise.resolve(IDLE) })
    ).resolves.toBe(true);
  });
});

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
    await seedSettings(db);
    state.db = db;
  });

  afterEach(() => {
    if (saved.reloadHour !== undefined) {
      process.env.TLS_RELOAD_HOUR = saved.reloadHour;
    }
  });

  function gate(): ReturnType<typeof createMaintenanceGate> {
    if (state.db === undefined) {
      throw new Error('no database');
    }
    return createMaintenanceGate({
      db: state.db,
      isIdle: () => {
        state.asked += 1;
        return Promise.resolve(state.idle);
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
      nextCheckAt: new Date('2026-01-02T03:00:00Z')
    });
    await expect(
      shared.check(new Date('2026-01-02T03:00:00Z'))
    ).resolves.toEqual({ open: true });
  });

  it('resolves a fresh moment after opening and after reset', async () => {
    const shared = gate();
    await expect(
      shared.check(new Date('2026-01-01T03:30:00Z'))
    ).resolves.toEqual({
      open: false,
      nextCheckAt: new Date('2026-01-02T03:00:00Z')
    });
    shared.reset();
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
