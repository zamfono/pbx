import type { Transaction } from 'kysely';

import type { DB, SipHeaderTemplate } from '@zamfono/shared';

import { type TargetSpec } from '../forwardTargetSchema.js';
import { rowToTarget } from '../forwardTargetSpec.js';

/** §11.2 `user_forward_rules` CHECK: the classic CFU/CFB/CFNR conditions plus presence-aware ones. */
export const CONDITIONS = [
  'unconditional',
  'busy',
  'noAnswer',
  'dnd',
  'offline'
] as const;
export type Condition = (typeof CONDITIONS)[number];

/** One stored rule: the wire rule `users.getForwarding` returns, plus the target row it owns. */
export type StoredForwardRule = {
  condition: Condition;
  target: TargetSpec;
  targetId: string;
};

/**
 * A user's stored forwarding rules in `CONDITIONS` order, each target as the wire returns it
 * (§10.3 "Forward targets"), so a read is exactly what `users.setForwarding` takes back.
 */
export async function storedForwardRules(
  db: Transaction<DB>,
  userId: string
): Promise<StoredForwardRule[]> {
  const rows = await db
    .selectFrom('userForwardRules')
    .innerJoin(
      'forwardTargets',
      'forwardTargets.id',
      'userForwardRules.targetId'
    )
    .selectAll('forwardTargets')
    .select(['userForwardRules.condition', 'userForwardRules.targetId'])
    .where('userForwardRules.userId', '=', userId)
    .execute();
  const byCondition = (rule: { condition: string }): number =>
    CONDITIONS.indexOf(rule.condition as Condition);
  return rows
    .map(row => ({
      condition: row.condition as Condition,
      target: rowToTarget(row),
      targetId: row.targetId
    }))
    .sort((left, right) => byCondition(left) - byCondition(right));
}

/** A `sip` target's headers as `[name, value]` pairs in order, compared without key order. */
function headerPairs(headers: SipHeaderTemplate[]): string {
  return JSON.stringify(headers.map(header => [header.name, header.value]));
}

/**
 * §10.3 "Forward targets": whether `input` is the very `sip` target `stored` holds, the same
 * trunk, user part and headers, in order, name for name and value for value. `stored` comes
 * through `rowToTarget`, so its headers are the parsed JSON the wire returns.
 */
export function isSameSipTarget(
  stored: TargetSpec,
  input: TargetSpec
): boolean {
  if (stored.kind !== 'sip' || input.kind !== 'sip') {
    return false;
  }
  return (
    stored.trunkId === input.trunkId &&
    stored.user === input.user &&
    headerPairs(stored.headers) === headerPairs(input.headers)
  );
}
