import type { Selectable } from 'kysely';

import type { DB } from '@zamfono/shared';

import { recordChange } from '../runner.js';
import type { Context } from '../types.js';

/** A `users` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
type UserRow = Selectable<DB['users']>;

/** Columns stored as 0/1 (nullable) INTEGER whose wire type is a `boolean` (§11.1, §10.3). */
const NULLABLE_BOOLEAN_COLUMNS = new Set(['clir', 'rejectAnonymous']);
/** Columns stored as 0/1 INTEGER whose wire type is a non-nullable `boolean` (§11.1, §10.3). */
const BOOLEAN_COLUMNS = new Set([
  'recordCalls',
  'notifyMissedCalls',
  'mailboxEnabled'
]);

/**
 * Records one `audit_log` diff entry per column in `after` that changed from `before`, under its
 * wire field name and value (§10.3 "Conventions": storage suffixes never cross the boundary, and
 * every value a client sees, `GET /audit` included, is a wire value) — `findMeJson`'s JSON string
 * becomes `findMe`'s parsed array, a boolean column's 0/1/`null` becomes `false`/`true`/`null`;
 * every other column here already shares its name and value type with the wire field it maps to.
 */
export function recordFieldChanges(
  ctx: Context,
  before: UserRow,
  after: Record<string, unknown>
): void {
  const beforeRecord = before as unknown as Record<string, unknown>;
  for (const [column, value] of Object.entries(after)) {
    if (value === beforeRecord[column]) {
      continue;
    }
    if (column === 'findMeJson') {
      recordChange(ctx, {
        field: 'findMe',
        from: before.findMeJson ? JSON.parse(before.findMeJson) : [],
        to: value ? JSON.parse(value as string) : []
      });
      continue;
    }
    if (NULLABLE_BOOLEAN_COLUMNS.has(column) || BOOLEAN_COLUMNS.has(column)) {
      recordChange(ctx, {
        field: column,
        from:
          beforeRecord[column] === null ? null : Boolean(beforeRecord[column]),
        to: value === null ? null : Boolean(value)
      });
      continue;
    }
    recordChange(ctx, { field: column, from: beforeRecord[column], to: value });
  }
}
