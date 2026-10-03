import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { Db, DB } from '@zamfono/shared';

import { targetSpecSchema } from '../forwardTargetSchema.js';
import { liveRow } from '../rows.js';
import { scopeColumns, type ScopeInput } from '../scope.js';

export type OooRuleRow = Selectable<DB['oooRules']>;

/**
 * `startsAt`/`expiresAt` on input: ISO-8601, any offset (clients send local time), normalized to
 * UTC via `toUtcIso` before it reaches the overlap check or the `_at` column (Global Constraints:
 * "Timestamps TEXT ISO 8601 UTC").
 */
export const isoDatetimeInput = z.iso.datetime({ offset: true });

/** The fields `ooo.create` takes and `ooo.update` takes each optionally (§10.3). */
export const oooFields = {
  active: z
    .boolean()
    .optional()
    .describe('Whether the rule applies at all; on by default.'),
  startsAt: isoDatetimeInput
    .nullable()
    .optional()
    .describe(
      'When the rule takes effect, ISO 8601 with an offset; null: immediately.'
    ),
  expiresAt: isoDatetimeInput
    .nullable()
    .optional()
    .describe(
      'When the rule ends, after startsAt; null: until deactivated. Active periods within a scope must not overlap.'
    ),
  target: targetSpecSchema.describe(
    "Where the scope's calls go while the rule is in effect, ahead of opening hours (see zamfono.help vacation-rule)."
  )
};

/** `value` as a UTC ISO-8601 string, so stored `_at` values compare and parse consistently. */
export function toUtcIso(value: string): string {
  return new Date(value).toISOString();
}

/** `toUtcIso` over an optional/nullable input field, preserving "absent" vs. explicit `null`. */
export function normalizeIsoOrNull(
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return toUtcIso(value);
}

/**
 * Whether the half-open periods `[aStart, aEnd)` and `[bStart, bEnd)` intersect, `null` standing
 * for the unbounded side (§11.2 `ooo_rules`: NULL `starts_at` = immediately, NULL `expires_at` =
 * until deactivated). An open-ended period therefore overlaps every later period.
 */
export function rangesOverlap(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null
): boolean {
  const aStartsBeforeBEnds = aStart === null || bEnd === null || aStart < bEnd;
  const bStartsBeforeAEnds = bStart === null || aEnd === null || bStart < aEnd;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/** The live `ooo_rules` row with `id`, or `OpError(404)`. */
export async function liveOooRule(db: Db, id: string): Promise<OooRuleRow> {
  return liveRow(db, 'oooRules', id, 'ooo: rule not found');
}

/**
 * Every live `ooo_rules` row in `scope`, in `starts_at` order (NULLs, meaning "now", first), ties
 * broken by id so `ooo.list`'s offset cursor resumes on a stable order.
 */
export async function liveOooRulesInScope(
  db: Db,
  scope: ScopeInput
): Promise<OooRuleRow[]> {
  const columns = scopeColumns(scope);
  return db
    .selectFrom('oooRules')
    .selectAll()
    .where(
      'scopeUserId',
      columns.scopeUserId === null ? 'is' : '=',
      columns.scopeUserId
    )
    .where(
      'scopeRingGroupId',
      columns.scopeRingGroupId === null ? 'is' : '=',
      columns.scopeRingGroupId
    )
    .where(
      'scopeMenuId',
      columns.scopeMenuId === null ? 'is' : '=',
      columns.scopeMenuId
    )
    .where('deletedAt', 'is', null)
    .orderBy('startsAt')
    .orderBy('id')
    .execute();
}
