import { z } from 'zod';

import {
  USER_FORWARD_CONDITIONS,
  type Db,
  type UserForwardCondition
} from '@zamfono/shared';

import { ownTargetSchema, type TargetSpec } from '../forwardTargetSchema.js';
import { rowToTarget } from '../forwardTargetSpec.js';

/** A user's forwarding rules (§10.3 "Users"), as `users.setForwarding` takes them and both
 * forwarding operations return them. */
export const forwardingSchema = z
  .object({
    id: z.string(),
    rules: z
      .array(
        z.object({
          condition: z
            .enum(USER_FORWARD_CONDITIONS)
            .describe(
              'unconditional: every call; busy: every device busy; noAnswer: nobody answers within ringTimeoutS; dnd: DND on; offline: no registered device, falling to noAnswer without this rule.'
            ),
          target: ownTargetSchema
        })
      )
      .describe(
        "The user's rules, one per condition; a condition left out sends the call to the user's mailbox, else rejects it (see zamfono.help routing-order)."
      )
  })
  .strict();
export type Forwarding = z.infer<typeof forwardingSchema>;

/** One stored rule: its condition and target in full, as an admin reads it, plus the target row
 * it owns. */
export type StoredForwardRule = {
  condition: UserForwardCondition;
  target: TargetSpec;
  targetId: string;
};

/**
 * A user's stored forwarding rules in `USER_FORWARD_CONDITIONS` order, each target in full, as an
 * admin reads it and `users.setForwarding` takes it back (§10.3 "Forward targets").
 */
export async function storedForwardRules(
  db: Db,
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
  const byCondition = (rule: { condition: UserForwardCondition }): number =>
    USER_FORWARD_CONDITIONS.indexOf(rule.condition);
  const rules = await Promise.all(
    rows.map(async row => ({
      condition: row.condition,
      target: await rowToTarget(db, row),
      targetId: row.targetId
    }))
  );
  return rules.sort((left, right) => byCondition(left) - byCondition(right));
}
