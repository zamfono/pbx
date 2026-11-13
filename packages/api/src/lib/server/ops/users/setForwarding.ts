import {
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  type UserForwardCondition
} from '@zamfono/shared';

import { recordChange } from '../audit.js';
import {
  createTarget,
  deleteTargetIfOrphan,
  readableTarget,
  resolveOwnTarget
} from '../forwardTargets.js';
import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError } from '../types.js';
import { forwardingSchema, storedForwardRules } from './_forwarding.js';
import { liveUser } from './_shared.js';

/**
 * `PUT /users/{id}/forwarding` (§10.3, §11.2): replaces a user's forwarding rules as a whole,
 * self-service on a `user` actor's own id (§10.3 "Users"). An admin target is refused for a `user`
 * through `createTarget`; the marker a `user` reads for one keeps the target its condition holds,
 * on its own row (`resolveOwnTarget`); a rule the input leaves out is removed like any other
 * (§10.3 "Forward targets").
 */
export const setForwarding = defineOperation({
  name: 'users.setForwarding',
  description:
    "Replaces a user's call-forwarding rules as a whole; a user sets their own, without new sip, webSocket or recording targets, keeping an admin's by sending its { managed: true } marker back, an admin anyone's.",
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
    const next = input.rules.map(rule => ({
      condition: rule.condition,
      ...resolveOwnTarget(
        ctx,
        rule.target,
        existing.find(each => each.condition === rule.condition)
      )
    }));
    const keptIds = new Set(next.map(rule => rule.targetId));
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
    for (const rule of next) {
      const targetId =
        rule.targetId ??
        // eslint-disable-next-line no-await-in-loop -- in input order, so the first invalid target is the one refused and warnings follow the input
        (await createTarget(ctx, rule.target));
      rows.push({ userId: input.id, condition: rule.condition, targetId });
    }
    if (rows.length > 0) {
      await ctx.db.insertInto('userForwardRules').values(rows).execute();
    }
    // Recorded in this operation's own input shape, every target in full, a kept one as it is
    // held, so `audit.undo` replays `from` through it as one replace (§5.8).
    recordChange(ctx, {
      field: 'rules',
      from: existing.map(({ condition, target }) => ({ condition, target })),
      to: next.map(({ condition, target }) => ({ condition, target }))
    });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id: input.id,
      rules: next.map(({ condition, target }) => ({
        condition,
        target: readableTarget(ctx, target)
      }))
    };
  }
});
