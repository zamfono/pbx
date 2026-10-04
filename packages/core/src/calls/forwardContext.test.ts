import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../internal/snapshot.js';
import { newCall } from './call.js';
import {
  diversionFor,
  forwardVariables,
  redirectingVariables,
  type Diversion
} from './forwardContext.js';
import type { DiversionTrunk } from './forwardDiversion.js';

// §9.4 "Forwarded calls": what a forwarded trunk leg carries of its call's forwarding context.

const bea: Diversion = {
  number: '177',
  diversionNumber: '+15551177',
  name: 'Bea',
  reason: 'away',
  party: 'user',
  extension: '177'
};
const agent: Diversion = {
  number: '178',
  diversionNumber: '+15551000',
  name: null,
  reason: 'cfu',
  party: 'user',
  extension: '178'
};

describe('redirectingVariables', () => {
  it('sets nothing for a leg no hop led to', () => {
    expect(redirectingVariables([])).toEqual({});
  });

  it('holds the first hop as the original party and the last as the redirecting one', () => {
    expect(redirectingVariables([bea, agent])).toEqual({
      'REDIRECTING(orig-num,i)': '177',
      'REDIRECTING(orig-name,i)': 'Bea',
      'REDIRECTING(orig-reason,i)': 'away',
      'REDIRECTING(from-num,i)': '178',
      'REDIRECTING(reason,i)': 'cfu',
      'REDIRECTING(count,i)': '2'
    });
  });
});

describe('forwardVariables', () => {
  const trunk: DiversionTrunk = {
    policy: 'last',
    host: 'pbx.example',
    format: 'e164',
    country: 'US'
  };

  it("adds a leg's rendered headers with PJSIP_HEADER beside its REDIRECTING data", () => {
    expect(
      forwardVariables(
        {
          diversions: [],
          headers: [{ name: 'X-Zamfono-Caller', value: '+15559999' }]
        },
        trunk
      )
    ).toEqual({ 'PJSIP_HEADER(add,X-Zamfono-Caller)': '+15559999' });
  });

  it("adds the trunk's Diversion with PJSIP_HEADER, and none with the policy off", () => {
    const forward = { diversions: [bea, agent], headers: [] };
    expect(
      forwardVariables(forward, trunk)['PJSIP_HEADER(add,Diversion)']
    ).toBe('<sip:+15551000@pbx.example>;reason=unconditional');
    expect(
      Object.keys(forwardVariables(forward, { ...trunk, policy: 'off' }))
    ).not.toContain('PJSIP_HEADER(add,Diversion)');
  });
});

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
