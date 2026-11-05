import { z } from 'zod';

import {
  USER_FORWARD_CONDITIONS,
  type Db,
  type UserForwardCondition
} from '@zamfono/shared';

import { isAdminTarget, targetChain } from '../forwardTargets.js';
import { targetSpecSchema, type TargetSpec } from '../forwardTargetSchema.js';
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
          target: targetSpecSchema
        })
      )
      .describe(
        "The user's rules, one per condition; a condition left out sends the call to the user's mailbox, else rejects it (see zamfono.help routing-order)."
      )
  })
  .strict();
export type Forwarding = z.infer<typeof forwardingSchema>;

/** One stored rule: the wire rule `users.getForwarding` returns, plus the target row it owns. */
export type StoredForwardRule = {
  condition: UserForwardCondition;
  target: TargetSpec;
  targetId: string;
};

/**
 * A user's stored forwarding rules in `USER_FORWARD_CONDITIONS` order, each target as the wire returns it
 * (§10.3 "Forward targets"), so a read is exactly what `users.setForwarding` takes back.
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

/** `value` as JSON with every object's keys sorted, so two targets compare without key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : inner
  );
}

/**
 * §10.3 "Forward targets": whether `input` is the very target `stored` holds, field for field down
 * its whole fallback chain, a `sip` target's headers in order, while that chain holds an admin
 * target (`isAdminTarget`) anywhere. Both come parsed, `stored` through `rowToTarget`, so every
 * defaulted field (`sampleRate`, `ringTimeoutS`, `fallback`) is set on either side.
 */
export function isSameAdminTarget(
  stored: TargetSpec,
  input: TargetSpec
): boolean {
  return (
    targetChain(stored).some(isAdminTarget) &&
    canonical(stored) === canonical(input)
  );
}
