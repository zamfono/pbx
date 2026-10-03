import { describe, expect, it } from 'vitest';

import {
  decodeIdCursor,
  decodeOffsetCursor,
  keysetPage,
  offsetPage,
  pageInput
} from './pagination.js';

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
    const keyset = keysetPage(rows, 2);
    expect(keyset.page).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(decodeIdCursor(keyset.nextCursor ?? '')).toBe('b');
    expect(keysetPage(rows, 3).nextCursor).toBeNull();
    const offset = offsetPage(rows, 4, 2);
    expect(decodeOffsetCursor(offset.nextCursor ?? undefined)).toBe(6);
    expect(decodeOffsetCursor(undefined)).toBe(0);
  });

  it.each(['not-a-cursor', cursorOf(null), cursorOf({}), cursorOf('x')])(
    'refuses the malformed or foreign cursor %s with 422',
    cursor => {
      expect(() => decodeIdCursor(cursor)).toThrow(
        expect.objectContaining({ status: 422 })
      );
      expect(() => decodeOffsetCursor(cursor)).toThrow(
        expect.objectContaining({ status: 422 })
      );
    }
  );

  it('refuses an id cursor as an offset and a negative offset', () => {
    expect(() => decodeOffsetCursor(cursorOf({ id: 'a' }))).toThrow(
      expect.objectContaining({ status: 422 })
    );
    expect(() => decodeOffsetCursor(cursorOf({ offset: -1 }))).toThrow(
      expect.objectContaining({ status: 422 })
    );
  });
});
