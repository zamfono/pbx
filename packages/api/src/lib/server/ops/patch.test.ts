import { describe, expect, it } from 'vitest';

import { orBefore } from './patch.js';

describe('orBefore', () => {
  it('keeps before for an absent key and takes any given value, null included', () => {
    expect(orBefore(undefined, 'a')).toBe('a');
    expect(orBefore('b', 'a')).toBe('b');
    expect(orBefore<string | null>(null, 'a')).toBeNull();
  });
});
