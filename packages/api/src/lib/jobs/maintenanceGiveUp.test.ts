import { describe, expect, it } from 'vitest';

import type { StateResponse } from '@zamfono/shared';

import { makeTestDb } from '../testDb.js';
import {
  busyOf,
  clearGiveUpsInARow,
  coreBusy,
  describeBusy,
  lastGiveUps,
  recordGiveUp
} from './maintenanceGiveUp.js';

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

describe('busyOf', () => {
  it('is idle with no call, no channel and no recording; registered devices do not count', () => {
    expect(busyOf(IDLE)).toBeNull();
  });

  it.each([
    [
      'a live call',
      { calls: [{} as StateResponse['calls'][number]], asteriskChannels: 2 },
      { liveCalls: 1, asteriskChannels: 2, recordingsInProgress: 0 }
    ],
    [
      'a channel only Asterisk holds, such as a parked party',
      { asteriskChannels: 1 },
      { liveCalls: 0, asteriskChannels: 1, recordingsInProgress: 0 }
    ],
    [
      'a recording still being mixed',
      { recordingsInProgress: 1 },
      { liveCalls: 0, asteriskChannels: 0, recordingsInProgress: 1 }
    ],
    [
      'ARI not answering',
      { asteriskChannels: null },
      { liveCalls: 0, asteriskChannels: null, recordingsInProgress: 0 }
    ]
  ])('is busy with %s, counting it', (_label, overrides, busy) => {
    expect(busyOf({ ...IDLE, ...overrides })).toEqual(busy);
  });

  it('is busy for a core that does not report its channels', () => {
    const older: Partial<StateResponse> = { ...IDLE };
    delete older.asteriskChannels;
    expect(busyOf(older as StateResponse)).toEqual({
      liveCalls: 0,
      asteriskChannels: null,
      recordingsInProgress: 0
    });
  });
});

describe('coreBusy', () => {
  it('is busy while core does not answer, saying so', async () => {
    await expect(
      coreBusy({ state: () => Promise.reject(new Error('down')) })
    ).resolves.toEqual({ coreError: 'down' });
  });

  it('reads the live state', async () => {
    await expect(
      coreBusy({ state: () => Promise.resolve(IDLE) })
    ).resolves.toBeNull();
  });
});

describe('describeBusy', () => {
  it.each([
    [
      { liveCalls: 1, asteriskChannels: 2, recordingsInProgress: 0 },
      'live calls 1, Asterisk channels 2, recordings in progress 0'
    ],
    [
      { liveCalls: 0, asteriskChannels: null, recordingsInProgress: 0 },
      'live calls 0, Asterisk channels unknown, ARI did not answer, recordings in progress 0'
    ],
    [{ coreError: 'fetch failed' }, 'core did not answer: fetch failed']
  ])('names %j as %j', (busy, words) => {
    expect(describeBusy(busy)).toBe(words);
  });
});

describe('lastGiveUps', () => {
  it('is the last give-up per work, kept after its run in a row ends', async () => {
    const db = await makeTestDb();
    await expect(lastGiveUps(db)).resolves.toEqual({
      certSync: null,
      autoUpdate: null
    });

    await recordGiveUp(db, {
      work: 'autoUpdate',
      moment: new Date('2026-10-01T03:00:00Z'),
      busy: { coreError: 'fetch failed' },
      at: new Date('2026-10-01T05:00:00Z')
    });
    await clearGiveUpsInARow(db, 'autoUpdate');

    await expect(lastGiveUps(db)).resolves.toEqual({
      certSync: null,
      autoUpdate: {
        at: '2026-10-01T05:00:00.000Z',
        reason: 'core did not answer: fetch failed'
      }
    });
  });
});
