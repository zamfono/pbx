import { describe, expect, it } from 'vitest';

import { mwiMailboxOf, parseMwiMailbox } from './mwiMailbox.js';

const ID = '0b5e8f1c-3d2a-4c6b-9e7f-1a2b3c4d5e6f';

describe('mwiMailboxOf', () => {
  it("names a user's and a ring group's mailbox by kind and id", () => {
    expect(mwiMailboxOf({ userId: ID })).toBe(`user:${ID}`);
    expect(mwiMailboxOf({ ringGroupId: ID })).toBe(`ringGroup:${ID}`);
  });
});

describe('parseMwiMailbox', () => {
  it('reads back the owner mwiMailboxOf named', () => {
    for (const owner of [{ userId: ID }, { ringGroupId: ID }]) {
      expect(parseMwiMailbox(mwiMailboxOf(owner))).toEqual(owner);
    }
  });
});
