import type { Transaction } from 'kysely';
import { z } from 'zod';

import {
  RING_GROUP_FORWARD_CONDITIONS,
  type DB,
  type RingGroupForwardCondition
} from '@zamfono/shared';

import { targetSpecSchema, type TargetSpec } from '../forwardTargetSchema.js';
import { rowToTarget } from '../forwardTargetSpec.js';

const forwardingRuleSchema = z.object({
  condition: z
    .enum(RING_GROUP_FORWARD_CONDITIONS)
    .describe(
      'unanswered: rang and nobody answered; unavailable: no ringable member, fires without ringing and falls to unanswered without this rule.'
    ),
  target: targetSpecSchema
});

/** A ring group's forwarding rules (§10.3 "Ring groups"), as `ringGroups.setForwarding` takes
 * them and both forwarding operations return them. */
export const ringGroupForwardingSchema = z
  .object({
    id: z.string(),
    rules: z
      .array(forwardingRuleSchema)
      .describe(
        "The group's rules, one per condition; without an unanswered rule the call goes to the group's mailbox, else is rejected."
      )
  })
  .strict();

/** One stored rule: the wire rule `ringGroups.getForwarding` returns, plus the target row it owns. */
export type StoredRingGroupForwardRule = {
  condition: RingGroupForwardCondition;
  target: TargetSpec;
  targetId: string;
};

/**
 * A ring group's stored forwarding rules in `RING_GROUP_FORWARD_CONDITIONS` order, each target as
 * the wire returns it (§10.3 "Forward targets"), so a read is exactly what
 * `ringGroups.setForwarding` takes back.
 */
export async function storedRingGroupForwardRules(
  db: Transaction<DB>,
  groupId: string
): Promise<StoredRingGroupForwardRule[]> {
  const rows = await db
    .selectFrom('ringGroupForwardRules')
    .innerJoin(
      'forwardTargets',
      'forwardTargets.id',
      'ringGroupForwardRules.targetId'
    )
    .selectAll('forwardTargets')
    .select([
      'ringGroupForwardRules.condition',
      'ringGroupForwardRules.targetId'
    ])
    .where('ringGroupForwardRules.groupId', '=', groupId)
    .execute();
  const byCondition = (rule: {
    condition: RingGroupForwardCondition;
  }): number => RING_GROUP_FORWARD_CONDITIONS.indexOf(rule.condition);
  return rows
    .map(row => ({
      condition: row.condition,
      target: rowToTarget(row),
      targetId: row.targetId
    }))
    .sort((left, right) => byCondition(left) - byCondition(right));
}
