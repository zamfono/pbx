import Database from 'better-sqlite3';

import { HTTP_CONFLICT } from '@zamfono/shared';

import { OpError } from '../types.js';

/** SQLite's extended result codes for a write that would duplicate a unique key (§11.2). */
const UNIQUE_VIOLATION_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY'
]);

/**
 * Runs `revert`, answering a uniqueness violation it hits with a 409 rather than an opaque 500
 * (§5.8 "The reverted state violates no uniqueness rule"). The reuse checks refuse every
 * collision they know of first, naming the newer row; this is the backstop for one they miss.
 */
export async function refuseUniqueViolation(
  revert: () => Promise<void>
): Promise<void> {
  try {
    await revert();
  } catch (error) {
    if (
      error instanceof Database.SqliteError &&
      UNIQUE_VIOLATION_CODES.has(error.code)
    ) {
      throw new OpError(
        HTTP_CONFLICT,
        'audit.undo: the reverted state violates a uniqueness rule'
      );
    }
    throw error;
  }
}
