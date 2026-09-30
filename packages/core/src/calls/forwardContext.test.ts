import { describe, expect, it } from 'vitest';

import { redirectingVariables, type Diversion } from './forwardContext.js';
import { forwardHeaders, headerVariables } from './forwardHeaders.js';

// §9.4 "Forwarded calls": what a forwarded trunk leg carries of its call's forwarding context.

describe('forwardHeaders', () => {
  it('names the caller and the called company number of an inbound call', () => {
    expect(
      forwardHeaders({ caller: '+15559999', called: '+15551077' })
    ).toEqual([
      { name: 'X-Zamfono-Caller', value: '+15559999' },
      { name: 'X-Zamfono-Did', value: '+15551077' }
    ]);
  });

  it('omits the caller who withheld their number', () => {
    expect(
      forwardHeaders({ caller: 'anonymous', called: '+15551077' })
    ).toEqual([{ name: 'X-Zamfono-Did', value: '+15551077' }]);
    expect(forwardHeaders({ caller: '', called: null })).toEqual([]);
  });

  it("names an internal caller's extension and no DID, nor a verbatim called string", () => {
    expect(forwardHeaders({ caller: '101', called: null })).toEqual([
      { name: 'X-Zamfono-Caller', value: '101' }
    ]);
    expect(forwardHeaders({ caller: '101', called: 'acct-4711' })).toEqual([
      { name: 'X-Zamfono-Caller', value: '101' }
    ]);
  });

  it('adds each header with PJSIP_HEADER', () => {
    expect(
      headerVariables([{ name: 'X-Zamfono-Caller', value: '+15559999' }])
    ).toEqual({ 'PJSIP_HEADER(add,X-Zamfono-Caller)': '+15559999' });
  });
});

describe('redirectingVariables', () => {
  const bea: Diversion = { number: '177', name: 'Bea', reason: 'away' };
  const agent: Diversion = { number: '178', name: null, reason: 'cfu' };

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
