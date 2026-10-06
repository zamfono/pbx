import { describe, expect, it } from 'vitest';

import { nextHop, targetFromRow, type ForwardTarget } from './targets.js';

const userTarget: ForwardTarget = {
  kind: 'user',
  userId: 'u1'
};
const menuTarget: ForwardTarget = {
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
      kind: 'sip',
      trunkId: 'trunk-1',
      user: 'proj_1',
      headers: []
    };
    expect(nextHop(3, sipTarget)).toEqual({ ok: true, hops: 3 });
  });
});

describe('targetFromRow', () => {
  const sipRow = {
    id: 'ft-1',
    userId: null,
    ringGroupId: null,
    external: null,
    sipTrunkId: 'trunk-1',
    sipUser: 'proj_1',
    sipHeaders: [{ name: 'X-Called', value: '{{calledExtension}}' }],
    mailboxUserId: null,
    mailboxRingGroupId: null,
    announcementAudioId: null,
    menuId: null,
    recordCalls: 0
  };

  it("reads a sip target's column pair and its headers", () => {
    expect(targetFromRow(sipRow)).toEqual({
      kind: 'sip',
      trunkId: 'trunk-1',
      user: 'proj_1',
      headers: [{ name: 'X-Called', value: '{{calledExtension}}' }]
    });
  });

  it('reads a recording target as one that records (§10.2 "Recording semantics")', () => {
    expect(targetFromRow({ ...sipRow, recordCalls: 1 })).toMatchObject({
      kind: 'sip',
      record: true
    });
    expect(
      targetFromRow({
        ...sipRow,
        external: '+15557777',
        sipTrunkId: null,
        sipUser: null,
        sipHeaders: null,
        recordCalls: 1
      })
    ).toEqual({ kind: 'external', number: '+15557777', record: true });
  });
});
