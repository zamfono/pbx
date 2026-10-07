import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../internal/snapshot.js';
import { newCall } from './call.js';
import { diversionFor } from './forwardContext.js';

// §9.4 "Forwarded calls": the hops a call's forwarding context records.

describe('diversionFor', () => {
  it("names a menu of an internal call by the tenant's main number, keeping the hop", () => {
    const snapshot = {
      settings: { mainDidId: 'd-main' },
      dids: [{ id: 'd-main', number: '+15551000' }],
      menus: [{ id: 'm-1', name: 'Hotline' }]
    } as unknown as Snapshot;
    const call = newCall({
      id: 'c-1',
      direction: 'internal',
      callerChannelId: 'chan-1',
      from: '177',
      to: '500',
      startedAt: '2026-09-30T12:00:00.000Z',
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });

    expect(diversionFor(snapshot, call, { menuId: 'm-1' }, 'away')).toEqual({
      number: '+15551000',
      diversionNumber: '+15551000',
      name: 'Hotline',
      reason: 'away',
      party: 'menu',
      extension: null
    });
  });
});
