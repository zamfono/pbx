import { describe, expect, it } from 'vitest';

import {
  decodeIdCursor,
  decodeOffsetCursor,
  keysetPage,
  offsetPage,
  pageInput
} from './pagination.js';

const LIST = 'audit.list';

function cursorOf(position: unknown): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

describe('pagination', () => {
  it('defaults the limit to 50 and refuses more than 200', () => {
    expect(pageInput.parse({}).limit).toBe(50);
    expect(pageInput.parse({ limit: 200 }).limit).toBe(200);
    expect(pageInput.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('resumes where the previous page ended', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const keyset = keysetPage(LIST, rows, 2);
    expect(keyset.page).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(decodeIdCursor(LIST, keyset.nextCursor ?? '')).toBe('b');
    expect(keysetPage(LIST, rows, 3).nextCursor).toBeNull();
    const offset = offsetPage(LIST, rows, 4, 2);
    expect(decodeOffsetCursor(LIST, offset.nextCursor ?? undefined)).toBe(6);
    expect(decodeOffsetCursor(LIST, undefined)).toBe(0);
  });

  it.each([
    'not-a-cursor',
    cursorOf(null),
    cursorOf({}),
    cursorOf('x'),
    cursorOf({ id: 'a', offset: 0 }),
    cursorOf({ list: 'dids.list', id: 'a', offset: 0 })
  ])('refuses the malformed or foreign cursor %s with 422', cursor => {
    expect(() => decodeIdCursor(LIST, cursor)).toThrow(
      expect.objectContaining({ status: 422 })
    );
    expect(() => decodeOffsetCursor(LIST, cursor)).toThrow(
      expect.objectContaining({ status: 422 })
    );
  });

  it("refuses another list's cursor with 422 (§10.3)", () => {
    const { nextCursor } = keysetPage(
      'dids.list',
      [{ id: 'a' }, { id: 'b' }],
      1
    );
    expect(() => decodeIdCursor(LIST, nextCursor ?? '')).toThrow(
      expect.objectContaining({ status: 422 })
    );
  });

  it('refuses an id cursor as an offset and a negative offset', () => {
    expect(() =>
      decodeOffsetCursor(LIST, cursorOf({ list: LIST, id: 'a' }))
    ).toThrow(expect.objectContaining({ status: 422 }));
    expect(() =>
      decodeOffsetCursor(LIST, cursorOf({ list: LIST, offset: -1 }))
    ).toThrow(expect.objectContaining({ status: 422 }));
  });
});
