import { describe, expect, it } from 'vitest';

import { nextHop, targetFromRow, type ForwardTarget } from './targets.js';

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

  // §10.1 step 7: a SIP target, like an external number, neither counts a hop nor re-enters.
  it('lets a sip target through at the third hop without counting it', () => {
    const sipTarget: ForwardTarget = {
      id: 'target-3',
      kind: 'sip',
      trunkId: 'trunk-1',
      user: 'proj_1'
    };
    expect(nextHop(3, sipTarget)).toEqual({ ok: true, hops: 3 });
  });
});

describe('targetFromRow', () => {
  it("reads a sip target's column pair", () => {
    expect(
      targetFromRow({
        id: 'ft-1',
        userId: null,
        ringGroupId: null,
        external: null,
        sipTrunkId: 'trunk-1',
        sipUser: 'proj_1',
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: null,
        menuId: null
      })
    ).toEqual({ id: 'ft-1', kind: 'sip', trunkId: 'trunk-1', user: 'proj_1' });
  });
});
