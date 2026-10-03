import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { OpError } from './ops/types.js';

// §10.3 "Conventions": list endpoints paginate with `?limit=` and an opaque `?cursor=`, returning
// `{ items, nextCursor }`. The cursor carries whatever position value the operation itself needs
// to resume (a row id, a compound sort key, …); base64url just keeps the wire form opaque.
const CURSOR_ENCODING = 'base64url';

/** Encodes a list operation's resume position as an opaque `nextCursor` value. */
export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString(
    CURSOR_ENCODING
  );
}

/**
 * Decodes a cursor produced by `encodeCursor`. Throws `OpError(422)` on a malformed value: a
 * cursor only ever arrives back as this same operation's own previous `nextCursor`.
 */
export function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, CURSOR_ENCODING).toString('utf8'));
  } catch {
    throw new OpError(HTTP_UNPROCESSABLE_CONTENT, 'invalid cursor');
  }
}

/** The row id an id-keyed list resumes after, from its cursor `encodeCursor({ id })`. */
export function decodeIdCursor(cursor: string): string {
  const position = decodeCursor(cursor) as { id?: unknown } | null;
  if (typeof position?.id !== 'string') {
    throw new OpError(HTTP_UNPROCESSABLE_CONTENT, 'invalid cursor');
  }
  return position.id;
}
