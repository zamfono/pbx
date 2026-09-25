import { describe, expect, it } from 'vitest';

import { nextHop, type ForwardTarget } from './targets.js';

const userTarget: ForwardTarget = {
  id: 'target-1',
  kind: 'user',
  userId: 'u1'
};
const menuTarget: ForwardTarget = {
  id: 'target-2',
  kind: 'menu',
  menuId: 'menu-1'
};

describe('nextHop', () => {
  it('refuses a user target at the third hop', () => {
    expect(nextHop(3, userTarget)).toEqual({ ok: false });
  });

  it('lets a menu target re-enter at the third hop without counting it', () => {
    expect(nextHop(3, menuTarget)).toEqual({ ok: true, hops: 3 });
  });
});
