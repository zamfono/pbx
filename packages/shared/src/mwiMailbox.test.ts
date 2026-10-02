import { describe, expect, it } from 'vitest';

import { isMwiMailbox, mwiMailboxOf, parseMwiMailbox } from './mwiMailbox.js';

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

describe('isMwiMailbox', () => {
  it('admits only the names mwiMailboxOf produces', () => {
    expect(isMwiMailbox(mwiMailboxOf({ userId: ID }))).toBe(true);
    expect(isMwiMailbox(mwiMailboxOf({ ringGroupId: ID }))).toBe(true);
    for (const name of [
      'user:1',
      `menu:${ID}`,
      `user:${ID}/x`,
      `user:../${ID}`
    ]) {
      expect(isMwiMailbox(name)).toBe(false);
    }
  });
});
