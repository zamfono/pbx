import { describe, expect, it } from 'vitest';

import type { ForwardTarget } from './targets.js';
import { userEntryDecision } from './user.js';

const externalTarget = (): ForwardTarget => ({
  id: 'target-1',
  kind: 'external',
  number: '+491700000000'
});

const baseUser = {
  id: 'user-1',
  dnd: false,
  mailboxEnabled: false,
  findMe: [],
  registeredDevices: 0
};

describe('userEntryDecision', () => {
  it('applies the implicit mailbox default for DND with no dnd rule and mailbox enabled', () => {
    const result = userEntryDecision(
      { ...baseUser, dnd: true, mailboxEnabled: true },
      {}
    );

    expect(result).toEqual({ kind: 'mailbox', userId: 'user-1' });
  });

  it('releases with 486 for DND with no dnd rule and no mailbox', () => {
    const result = userEntryDecision(
      { ...baseUser, dnd: true, mailboxEnabled: false },
      {}
    );

    expect(result).toEqual({ kind: 'release', code: 486 });
  });

  it("falls back to the noAnswer rule's target when offline with no offline rule", () => {
    const noAnswerTarget = externalTarget();

    const result = userEntryDecision(baseUser, { noAnswer: noAnswerTarget });

    expect(result).toEqual({ kind: 'forward', target: noAnswerTarget });
  });

  it('lets an unconditional forward win over DND', () => {
    const unconditionalTarget = externalTarget();

    const result = userEntryDecision(
      { ...baseUser, dnd: true },
      { unconditional: unconditionalTarget }
    );

    expect(result).toEqual({ kind: 'forward', target: unconditionalTarget });
  });
});
