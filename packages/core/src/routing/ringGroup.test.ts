import { describe, expect, it } from 'vitest';

import {
  expandMembers,
  groupFallback,
  ringable,
  ringPlan,
  type MemberState
} from './ringGroup.js';
import type { ForwardTarget } from './targets.js';

const externalTarget = (id: string): ForwardTarget => ({
  id,
  kind: 'external',
  number: '+491700000000'
});

const mailboxTarget = (id: string): ForwardTarget => ({
  id,
  kind: 'mailboxUser',
  userId: 'user-mailbox'
});

const baseMember = (userId: string): MemberState => ({
  userId,
  dnd: false,
  registeredDevices: 1,
  inCall: false,
  oooInEffect: false,
  idleDevices: 1,
  unconditional: null,
  forwardRegisteredDevices: 0
});

const userTarget = (id: string): ForwardTarget => ({
  id,
  kind: 'user',
  userId: 'user-forwarded'
});

describe('expandMembers', () => {
  it('dedups a user reachable through two nested user groups (diamond nesting)', () => {
    const members = [
      { position: 1, userId: null, userGroupId: 'group-a' },
      { position: 2, userId: null, userGroupId: 'group-b' }
    ];
    const userGroupUsers = new Map([
      ['group-a', ['user-1']],
      ['group-b', ['user-1']]
    ]);
    const userGroupGroups = new Map<string, string[]>();
    const liveUserIds = new Set(['user-1']);

    const result = expandMembers(
      'ring-group-1',
      members,
      userGroupUsers,
      userGroupGroups,
      liveUserIds
    );

    expect(result).toEqual(['user-1']);
  });

  it('skips a member in a soft-deleted user set', () => {
    const members = [{ position: 1, userId: 'user-1', userGroupId: null }];

    const result = expandMembers(
      'ring-group-1',
      members,
      new Map(),
      new Map(),
      new Set()
    );

    expect(result).toEqual([]);
  });
});

describe('ringable', () => {
  it('keeps a busy member when skipBusy is false', () => {
    const members = [{ ...baseMember('user-1'), inCall: true }];

    const result = ringable(members, false);

    expect(result).toEqual([{ userId: 'user-1', via: 'devices' }]);
  });

  it('drops a busy member without another device to ring when skipBusy is false', () => {
    const members = [{ ...baseMember('user-1'), inCall: true, idleDevices: 0 }];

    expect(ringable(members, false)).toEqual([]);
  });

  it('drops a busy member when skipBusy is true', () => {
    const members = [{ ...baseMember('user-1'), inCall: true }];

    const result = ringable(members, true);

    expect(result).toEqual([]);
  });

  it('skips a member whose unconditional forward targets a mailbox', () => {
    const members = [
      { ...baseMember('user-1'), unconditional: mailboxTarget('target-1') }
    ];

    const result = ringable(members, true);

    expect(result).toEqual([]);
  });

  it("follows a member's unconditional forward to an external number", () => {
    const target = externalTarget('target-1');
    const members = [{ ...baseMember('user-1'), unconditional: target }];

    const result = ringable(members, true);

    expect(result).toEqual([{ userId: 'user-1', via: 'forward', target }]);
  });

  // §10.1 step 5: "members who are DND, offline or under an in-effect OOO rule are skipped".
  it.each([
    { state: 'DND', overrides: { dnd: true } },
    { state: 'offline', overrides: { registeredDevices: 0 } },
    { state: 'under an OOO rule', overrides: { oooInEffect: true } }
  ])('skips a forwarding member who is $state', ({ overrides }) => {
    const members = [
      {
        ...baseMember('user-1'),
        ...overrides,
        unconditional: externalTarget('target-1')
      }
    ];

    expect(ringable(members, true)).toEqual([]);
  });

  it('skips a busy forwarding member while skipBusy is true', () => {
    const members = [
      {
        ...baseMember('user-1'),
        inCall: true,
        unconditional: externalTarget('target-1')
      }
    ];

    expect(ringable(members, true)).toEqual([]);
  });

  it('follows a forward to a user only while that user has a registered device', () => {
    const target = userTarget('target-1');
    const unreachable = [{ ...baseMember('user-1'), unconditional: target }];
    const reachable = [
      {
        ...baseMember('user-1'),
        unconditional: target,
        forwardRegisteredDevices: 1
      }
    ];

    expect(ringable(unreachable, true)).toEqual([]);
    expect(ringable(reachable, true)).toEqual([
      { userId: 'user-1', via: 'forward', target }
    ]);
  });
});

describe('ringPlan', () => {
  it('caps a sequential plan by ringTotalS, dropping the member past the cap', () => {
    const legs = [
      { userId: 'user-1', via: 'devices' as const },
      { userId: 'user-2', via: 'devices' as const },
      { userId: 'user-3', via: 'devices' as const }
    ];

    const plan = ringPlan(legs, 'sequential', 20, 30, () => 0);

    expect(plan).toEqual([
      { legs: [legs[0]], timeoutS: 20 },
      { legs: [legs[1]], timeoutS: 10 }
    ]);
  });

  it('shuffles a random plan deterministically from the injected rng', () => {
    const legs = [
      { userId: 'user-1', via: 'devices' as const },
      { userId: 'user-2', via: 'devices' as const },
      { userId: 'user-3', via: 'devices' as const }
    ];
    const rngValues = [0.9, 0.1];
    let call = 0;
    const rng = (): number => rngValues[call++] ?? 0;

    const plan = ringPlan(legs, 'random', 20, null, rng);

    expect(plan.map(step => step.legs[0]?.userId)).toEqual([
      'user-2',
      'user-1',
      'user-3'
    ]);
  });
});

describe('groupFallback', () => {
  const group = { mailboxEnabled: false, ringGroupId: 'ring-group-1' };

  it("falls back to the unanswered rule's target when unavailable has no rule", () => {
    const unanswered = externalTarget('target-1');

    const result = groupFallback(group, { unanswered }, 'unavailable');

    expect(result).toEqual({ kind: 'forward', target: unanswered });
  });

  it('applies the implicit mailbox default when no rule matches and mailbox is enabled', () => {
    const result = groupFallback(
      { ...group, mailboxEnabled: true },
      {},
      'unanswered'
    );

    expect(result).toEqual({
      kind: 'mailbox',
      ringGroupId: 'ring-group-1'
    });
  });

  it('releases with 480 when no rule matches and mailbox is disabled', () => {
    const result = groupFallback(group, {}, 'unanswered');

    expect(result).toEqual({ kind: 'release', code: 480 });
  });
});
