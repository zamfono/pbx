import type { Transaction } from 'kysely';
import { z } from 'zod';

import {
  USER_FORWARD_CONDITIONS,
  type DB,
  type SipHeaderTemplate,
  type UserForwardCondition
} from '@zamfono/shared';

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
  const byCondition = (rule: { condition: UserForwardCondition }): number =>
    USER_FORWARD_CONDITIONS.indexOf(rule.condition);
  return rows
    .map(row => ({
      condition: row.condition,
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
