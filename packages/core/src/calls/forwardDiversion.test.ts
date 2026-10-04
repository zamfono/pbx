import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../internal/snapshot.js';
import { newCall, type Call } from './call.js';
import type { Diversion } from './forwardContext.js';
import {
  diversionHeader,
  diversionNumber,
  diversionTrunk,
  type DiversionTrunk
} from './forwardDiversion.js';

// §9.4 "Forwarded calls": the `Diversion` a forwarded trunk leg carries under its trunk's
// `trunks.diversion`, each hop by its party's own number or the main number, never an extension.

const MAIN = '+15551000';

function hop(overrides: Partial<Diversion>): Diversion {
  return {
    number: '177',
    diversionNumber: '+15551177',
    name: 'Bea',
    reason: 'away',
    party: 'user',
    extension: '177',
    ...overrides
  };
}

const BEA = hop({});
const AI = hop({
  number: '178',
  diversionNumber: MAIN,
  name: 'AI Agent',
  reason: 'cfu',
  extension: '178'
});
const TRUNK: DiversionTrunk = {
  policy: 'all',
  host: '203.0.113.34',
  format: 'e164',
  country: 'DE'
};

describe('diversionHeader', () => {
  it('sends none with the policy off, and none for a leg no hop led to', () => {
    expect(diversionHeader([BEA, AI], { ...TRUNK, policy: 'off' })).toBeNull();
    expect(diversionHeader([], TRUNK)).toBeNull();
  });

  it('sends the newest hop alone with last', () => {
    expect(diversionHeader([BEA, AI], { ...TRUNK, policy: 'last' })).toBe(
      '"AI Agent" <sip:+15551000@203.0.113.34>;reason=unconditional'
    );
  });

  it('sends every hop, newest first, comma-separated in one field with all', () => {
    expect(diversionHeader([BEA, AI], TRUNK)).toBe(
      '"AI Agent" <sip:+15551000@203.0.113.34>;reason=unconditional, ' +
        '"Bea" <sip:+15551177@203.0.113.34>;reason=away'
    );
  });

  it('leaves out a hop without a number before the policy picks', () => {
    const lost = { ...AI, diversionNumber: null };
    expect(diversionHeader([BEA, lost], TRUNK)).toBe(
      '"Bea" <sip:+15551177@203.0.113.34>;reason=away'
    );
    expect(diversionHeader([BEA, lost], { ...TRUNK, policy: 'last' })).toBe(
      '"Bea" <sip:+15551177@203.0.113.34>;reason=away'
    );
    expect(diversionHeader([lost], TRUNK)).toBeNull();
  });

  it("names each REDIRECTING reason by RFC 5806's reason", () => {
    const reasons = {
      away: 'away',
      time_of_day: 'time-of-day',
      cfu: 'unconditional',
      cfb: 'user-busy',
      cfnr: 'no-answer',
      unavailable: 'unavailable',
      dnd: 'do-not-disturb'
    } as const;
    for (const [reason, sent] of Object.entries(reasons)) {
      expect(
        diversionHeader([hop({ reason: reason as Diversion['reason'] })], TRUNK)
      ).toBe(`"Bea" <sip:+15551177@203.0.113.34>;reason=${sent}`);
    }
  });

  it('formats the number as the trunk formats a caller ID', () => {
    expect(
      diversionHeader([hop({ diversionNumber: '+493012345' })], {
        ...TRUNK,
        format: 'national'
      })
    ).toBe('"Bea" <sip:03012345@203.0.113.34>;reason=away');
  });

  it('quotes the name safely and leaves an empty one out', () => {
    expect(
      diversionHeader([hop({ name: 'Bea "B" \\ Ops\r\nX-Evil: 1' })], TRUNK)
    ).toBe(
      '"Bea \\"B\\" \\\\ OpsX-Evil: 1" <sip:+15551177@203.0.113.34>;reason=away'
    );
    expect(diversionHeader([hop({ name: null })], TRUNK)).toBe(
      '<sip:+15551177@203.0.113.34>;reason=away'
    );
    expect(diversionHeader([hop({ name: 'ü'.repeat(40) })], TRUNK)).toBe(
      `"${'ü'.repeat(32)}" <sip:+15551177@203.0.113.34>;reason=away`
    );
  });

  it('sends none without a host to name', () => {
    expect(diversionHeader([BEA], { ...TRUNK, host: null })).toBeNull();
  });
});

const snapshot = {
  settings: { mainDidId: 'd-main', country: 'DE' },
  dids: [
    {
      id: 'd-main',
      number: MAIN,
      targetId: 't-menu',
      createdAt: '1'
    },
    {
      id: 'd-bea',
      number: '+15551177',
      targetId: 't-bea',
      createdAt: '1'
    },
    {
      id: 'd-sales-2',
      number: '+15551302',
      targetId: 't-sales',
      createdAt: '3'
    },
    {
      id: 'd-sales-v',
      number: 'sales-verbatim',
      targetId: 't-sales',
      createdAt: '1'
    },
    {
      id: 'd-sales-1',
      number: '+15551301',
      targetId: 't-sales',
      createdAt: '2'
    }
  ],
  forwardTargets: [
    { id: 't-bea', userId: 'u-bea', ringGroupId: null },
    { id: 't-sales', userId: null, ringGroupId: 'g-sales' },
    { id: 't-menu', userId: null, ringGroupId: null }
  ],
  users: [
    { id: 'u-bea', callerIdDidId: 'd-bea' },
    { id: 'u-ai', callerIdDidId: null },
    { id: 'u-left', callerIdDidId: 'd-gone' }
  ],
  trunks: [],
  trunkHosts: [
    {
      trunkId: 'tr-1',
      priority: 2,
      host: 'sip2.provider.example',
      port: null,
      direction: 'both'
    },
    {
      trunkId: 'tr-1',
      priority: 1,
      host: 'sip.provider.example',
      port: 5061,
      direction: 'outbound'
    },
    {
      trunkId: 'tr-1',
      priority: 3,
      host: '198.51.100.9',
      port: null,
      direction: 'inbound'
    }
  ]
} as unknown as Snapshot;

function call(overrides: Partial<Call> = {}): Call {
  return {
    ...newCall({
      id: 'c-1',
      direction: 'inbound',
      callerChannelId: 'chan-1',
      from: '+15559999',
      to: '+15551077',
      startedAt: '2026-09-30T12:00:00.000Z',
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    }),
    ...overrides
  };
}

describe('diversionNumber', () => {
  it("names a user's primary number, else the main number", () => {
    expect(diversionNumber(snapshot, call(), { userId: 'u-bea' })).toBe(
      '+15551177'
    );
    expect(diversionNumber(snapshot, call(), { userId: 'u-ai' })).toBe(MAIN);
    // A primary number since deleted, absent from the snapshot, counts as none.
    expect(diversionNumber(snapshot, call(), { userId: 'u-left' })).toBe(MAIN);
  });

  it("names a ring group's first-created international DID, else the main number", () => {
    expect(diversionNumber(snapshot, call(), { ringGroupId: 'g-sales' })).toBe(
      '+15551301'
    );
    expect(diversionNumber(snapshot, call(), { ringGroupId: 'g-none' })).toBe(
      MAIN
    );
  });

  it("names a menu's called number of an inbound call, else the main number", () => {
    expect(diversionNumber(snapshot, call(), { menuId: 'm-1' })).toBe(
      '+15551077'
    );
    expect(
      diversionNumber(snapshot, call({ to: 'verbatim' }), { menuId: 'm-1' })
    ).toBe(MAIN);
    expect(
      diversionNumber(snapshot, call({ direction: 'internal', to: '500' }), {
        menuId: 'm-1'
      })
    ).toBe(MAIN);
  });

  it('names none without the main number, a hop the header leaves out', () => {
    const noMain = {
      ...snapshot,
      settings: { ...snapshot.settings, mainDidId: 'd-deleted' }
    } as Snapshot;
    expect(diversionNumber(noMain, call(), { userId: 'u-ai' })).toBeNull();
  });
});

describe('diversionTrunk', () => {
  const trunk = {
    id: 'tr-1',
    diversion: 'last',
    callerIdHeader: 'from',
    callerIdFormat: 'national',
    username: null
  } as unknown as Snapshot['trunks'][number];

  it("takes the trunk's policy and format, and the stack's SIP address as the host", () => {
    expect(diversionTrunk(trunk, snapshot, '203.0.113.34')).toEqual({
      policy: 'last',
      host: '203.0.113.34',
      format: 'national',
      country: 'DE'
    });
  });

  it("names a pai trunk's from_domain, its first outbound host, as its From does", () => {
    const pai = { ...trunk, callerIdHeader: 'pai' as const, username: 'acct' };
    expect(diversionTrunk(pai, snapshot, '203.0.113.34').host).toBe(
      'sip.provider.example'
    );
  });
});
