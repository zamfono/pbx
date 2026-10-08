import { beforeEach, describe, expect, it } from 'vitest';

import { U } from '#lib/api/seed/ids.js';
import { resetDb } from '#lib/api/store.svelte.js';

import { describeLine, liveCounterpart } from './labels';

describe('liveCounterpart', () => {
  beforeEach(() => {
    resetDb();
  });

  it('names the other end of an internal call, whichever side the person is on', () => {
    const call = {
      direction: 'internal' as const,
      from: 'sip:102@pbx',
      to: 'sip:101@pbx'
    };
    expect(liveCounterpart(call, U.lea)).toBe('sip:102@pbx');
    expect(liveCounterpart(call, U.jonas)).toBe('sip:101@pbx');
  });

  it('names the caller of an inbound call and the callee of an outbound one', () => {
    expect(
      liveCounterpart(
        {
          direction: 'inbound',
          from: 'sip:+4981615552@pbx',
          to: 'sip:101@pbx'
        },
        U.lea
      )
    ).toBe('sip:+4981615552@pbx');
    expect(
      liveCounterpart(
        {
          direction: 'outbound',
          from: 'sip:101@pbx',
          to: 'sip:+4981615552@pbx'
        },
        U.lea
      )
    ).toBe('sip:+4981615552@pbx');
  });
});

describe('describeLine', () => {
  it('marks the codec step as Expert-only and leaves routing steps for everyone', () => {
    const at = '2026-10-06T09:37:20.000Z';
    expect(
      describeLine({ at, event: 'codecs', caller: 'g722', callee: 'opus' })
        .expert
    ).toBe(true);
    expect(describeLine({ at, event: 'answered' }).expert).toBeUndefined();
  });
});
