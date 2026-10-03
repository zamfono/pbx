import { describe, expect, it } from 'vitest';

import { TtlMap } from './ttlMap.js';

describe('TtlMap', () => {
  it('returns a value until its expiry and misses from then on', () => {
    let now = 0;
    const map = new TtlMap<string, number>(() => now);
    map.set('a', 1, 100);
    now = 99;
    expect(map.get('a')).toBe(1);
    now = 100;
    expect(map.get('a')).toBeUndefined();
  });

  it('misses a deleted key', () => {
    const map = new TtlMap<string, number>(() => 0);
    map.set('a', 1, 100);
    map.delete('a');
    expect(map.get('a')).toBeUndefined();
  });
});
