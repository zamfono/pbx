import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT, isRecord } from '@zamfono/shared';

import { OpError } from './ops/types.js';

// §10.3 "Conventions": list endpoints paginate with `?limit=` (at most 200) and an opaque
// `?cursor=`, returning `{ items, nextCursor }`. A list resumes either after a row id (keyset) or
// at an offset; the cursor names the list operation that handed it out, so another list's cursor
// is refused. base64url just keeps the wire form opaque.
const CURSOR_ENCODING = 'base64url';
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** The `{ limit, cursor }` input every list operation takes; `limit` defaults to 50. */
export const pageInput = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().optional()
});

function encodeCursor(list: string, position: object): string {
  return Buffer.from(JSON.stringify({ list, ...position }), 'utf8').toString(
    CURSOR_ENCODING
  );
}

function invalidCursor(): OpError {
  return new OpError(HTTP_UNPROCESSABLE_CONTENT, 'invalid cursor');
}

// A cursor only ever arrives back as this same operation's own previous `nextCursor`, so
// anything else, another list's cursor included, is refused with 422.
function decodeCursor(
  list: string,
  cursor: string
): { id?: unknown; offset?: unknown } {
  let position: unknown;
  try {
    position = JSON.parse(
      Buffer.from(cursor, CURSOR_ENCODING).toString('utf8')
    );
  } catch {
    throw invalidCursor();
  }
  if (!isRecord(position) || position.list !== list) {
    throw invalidCursor();
  }
  return position;
}

/** The row id keyset list `list` (its operation name) resumes after. */
export function decodeIdCursor(list: string, cursor: string): string {
  const { id } = decodeCursor(list, cursor);
  if (typeof id !== 'string') {
    throw invalidCursor();
  }
  return id;
}

/**
 * The offset offset-paginated list `list` (its operation name) resumes at; 0, the list's start,
 * without a cursor.
 */
export function decodeOffsetCursor(
  list: string,
  cursor: string | undefined
): number {
  if (cursor === undefined) {
    return 0;
  }
  const { offset } = decodeCursor(list, cursor);
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw invalidCursor();
  }
  return offset;
}

/**
 * A keyset page of list `list` from `limit + 1` fetched rows: the first `limit`, and the cursor
 * after the last.
 */
export function keysetPage<Row extends { id: string }>(
  list: string,
  rows: Row[],
  limit: number
): { page: Row[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    page,
    nextCursor:
      rows.length > limit && last ? encodeCursor(list, { id: last.id }) : null
  };
}

/**
 * An offset page of list `list` from `limit + 1` rows fetched at `offset`: the first `limit`, and
 * the next offset.
 */
export function offsetPage<Row>(
  list: string,
  rows: Row[],
  offset: number,
  limit: number
): { page: Row[]; nextCursor: string | null } {
  return {
    page: rows.slice(0, limit),
    nextCursor:
      rows.length > limit
        ? encodeCursor(list, { offset: offset + limit })
        : null
  };
}
