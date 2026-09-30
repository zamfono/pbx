import { describe, expect, it } from 'vitest';

import {
  forwardVariables,
  redirectingVariables,
  type Diversion
} from './forwardContext.js';

// §9.4 "Forwarded calls": what a forwarded trunk leg carries of its call's forwarding context.

describe('redirectingVariables', () => {
  const bea: Diversion = {
    number: '177',
    name: 'Bea',
    reason: 'away',
    party: 'user',
    extension: '177'
  };
  const agent: Diversion = {
    number: '178',
    name: null,
    reason: 'cfu',
    party: 'user',
    extension: '178'
  };

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
  it("adds a leg's rendered headers with PJSIP_HEADER beside its REDIRECTING data", () => {
    expect(
      forwardVariables({
        diversions: [],
        headers: [{ name: 'X-Zamfono-Caller', value: '+15559999' }]
      })
    ).toEqual({ 'PJSIP_HEADER(add,X-Zamfono-Caller)': '+15559999' });
  });
});
