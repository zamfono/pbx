import {
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  type UserForwardCondition
} from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { createTarget, deleteTargetIfOrphan } from '../forwardTargets.js';
import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  forwardingSchema,
  isSameAdminTarget,
  storedForwardRules,
  type Forwarding,
  type StoredForwardRule
} from './_forwarding.js';
import { liveUser } from './_shared.js';

type Rule = Forwarding['rules'][number];

/**
 * §10.3 "Forward targets": the stored target rows a `user` actor's input keeps as they are, by
 * condition, each a rule sent back with the very admin target (a `sip` one, or an `external` one
 * that records) its own condition already holds. Matched only under the same condition, so such a
 * target moved to another one is new and goes through `createTarget`'s 403; an admin's input keeps
 * none and writes every target afresh.
 */
function keptAdminTargets(
  ctx: Context,
  existing: StoredForwardRule[],
  rules: Rule[]
): Map<string, string> {
  const kept = new Map<string, string>();
  if (ctx.actor.role !== 'user') {
    return kept;
  }
  for (const rule of rules) {
    const stored = existing.find(each => each.condition === rule.condition);
    if (stored && isSameAdminTarget(stored.target, rule.target)) {
      kept.set(rule.condition, stored.targetId);
    }
  }
  return kept;
}

/**
 * `PUT /users/{id}/forwarding` (§10.3, §11.2): replaces a user's forwarding rules as a whole,
 * self-service on a `user` actor's own id (§10.3 "Users"). A `sip` target, or an `external` one that
 * records, is refused for a `user` through `createTarget`, unless it is the one the rule's condition already holds, which keeps its
 * own row; a rule the input leaves out is removed like any other (§10.3 "Forward targets").
 */
export const setForwarding = defineOperation({
  name: 'users.setForwarding',
  description:
    "Replaces a user's call-forwarding rules as a whole; a user sets their own, without new sip or recording targets, an admin anyone's.",
  input: forwardingSchema,
  output: forwardingSchema,
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownUserId,
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    await liveUser(ctx.db, input.id);
    const seenConditions = new Set<string>();
    for (const rule of input.rules) {
      if (seenConditions.has(rule.condition)) {
        throw new OpError(
          HTTP_UNPROCESSABLE_CONTENT,
          `users: duplicate forwarding condition '${rule.condition}'`
        );
      }
      seenConditions.add(rule.condition);
    }
    // Resolved before the delete below, since `forward_targets` rows are gone once it runs.
    const existing = await storedForwardRules(ctx.db, input.id);
    const kept = keptAdminTargets(ctx, existing, input.rules);
    const keptIds = new Set(kept.values());
    await ctx.db
      .deleteFrom('userForwardRules')
      .where('userId', '=', input.id)
      .execute();
    await Promise.all(
      existing
        .filter(rule => !keptIds.has(rule.targetId))
        .map(rule => deleteTargetIfOrphan(ctx, rule.targetId))
    );
    const rows: {
      userId: string;
      condition: UserForwardCondition;
      targetId: string;
    }[] = [];
    for (const rule of input.rules) {
      const targetId =
        kept.get(rule.condition) ??
        // eslint-disable-next-line no-await-in-loop -- in input order, so the first invalid target is the one refused and warnings follow the input
        (await createTarget(ctx, rule.target));
      rows.push({ userId: input.id, condition: rule.condition, targetId });
    }
    if (rows.length > 0) {
      await ctx.db.insertInto('userForwardRules').values(rows).execute();
    }
    // Recorded in this operation's own input shape, so `audit.undo` replays `from` through it as
    // one replace (§5.8).
    recordChange(ctx, {
      field: 'rules',
      from: existing.map(({ condition, target }) => ({ condition, target })),
      to: input.rules
    });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id, rules: input.rules };
  }
});
