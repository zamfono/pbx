import { describe, expect, it } from 'vitest';

import { isBlocked, rejectAnonymous, resolveInbound } from './entry.js';

describe('isBlocked', () => {
  it('blocks a caller matching a prefix entry', () => {
    const blocklist = [{ number: '+49900', isPrefix: true }];

    expect(isBlocked('+49900123', blocklist)).toBe(true);
  });

  it('does not block a longer number under an exact (non-prefix) entry', () => {
    const blocklist = [{ number: '+49900', isPrefix: false }];

    expect(isBlocked('+49900123', blocklist)).toBe(false);
  });
});

describe('resolveInbound', () => {
  it('prefers an exact dids row over a matching block', () => {
    const dids = [{ id: 'did-1', number: '+4989123', targetId: 'target-1' }];
    const blocks = [
      {
        id: 'block-1',
        base: '+4989',
        digits: null,
        fallbackTargetId: 'target-2'
      }
    ];

    const result = resolveInbound('+4989123', dids, blocks, null);

    expect(result).toEqual({
      kind: 'did',
      didId: 'did-1',
      targetId: 'target-1'
    });
  });

  it('matches a digits block only at the base plus exactly that many digits', () => {
    const blocks = [
      {
        id: 'block-1',
        base: '+4989123',
        digits: 2,
        fallbackTargetId: 'target-1'
      }
    ];

    const matching = resolveInbound('+498912345', [], blocks, null);
    const tooLong = resolveInbound('+49891234567', [], blocks, null);

    expect(matching).toEqual({
      kind: 'fallback',
      targetId: 'target-1',
      blockId: 'block-1'
    });
    expect(tooLong).toEqual({ kind: 'release', code: 404 });
  });

  it('releases with 404 for a number outside every DID and block with no tenant fallback', () => {
    const result = resolveInbound('+49891', [], [], null);

    expect(result).toEqual({ kind: 'release', code: 404 });
  });
});

describe('rejectAnonymous', () => {
  it("inherits the tenant default when the target's own reject_anonymous is NULL", () => {
    expect(rejectAnonymous('anonymous', { rejectAnonymous: null }, true)).toBe(
      true
    );
    expect(rejectAnonymous('anonymous', { rejectAnonymous: null }, false)).toBe(
      false
    );
  });
});
