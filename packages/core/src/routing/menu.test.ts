import { describe, expect, it } from 'vitest';

import { menuStep, type MenuMap } from './menu.js';

describe('menuStep', () => {
  const map: MenuMap = [
    { digits: '1', targetId: 'target-1' },
    { digits: '12', targetId: 'target-12' }
  ];

  it('waits while the typed string still prefixes a longer mapped one', () => {
    expect(menuStep(map, '1', false)).toEqual({ kind: 'wait' });
  });

  it('matches once the typed string no longer prefixes a longer one', () => {
    expect(menuStep(map, '12', false)).toEqual({
      kind: 'match',
      targetId: 'target-12'
    });
  });

  it('resolves a partial match on timeout', () => {
    expect(menuStep(map, '1', true)).toEqual({
      kind: 'match',
      targetId: 'target-1'
    });
  });

  it('reports no match for a string nothing maps', () => {
    expect(menuStep(map, '3', false)).toEqual({ kind: 'nomatch' });
  });
});
