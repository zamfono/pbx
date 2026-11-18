import {
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  type UserForwardCondition
} from '@zamfono/shared';

import { recordChange } from '../audit.js';
import {
  readableTarget,
  resolveOwnTarget,
  writeTarget
} from '../forwardTargets.js';
import { deleteForwardTargets } from '../forwardTargetWrite.js';
import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError } from '../types.js';
import { forwardingSchema, storedForwardRules } from './_forwarding.js';
import { liveUser } from './_shared.js';

/**
 * `PUT /users/{id}/forwarding` (§10.3, §11.2): replaces a user's forwarding rules as a whole,
 * self-service on a `user` actor's own id (§10.3 "Users"). An admin target is refused for a `user`
 * through `writeTarget`; the marker a `user` reads for one keeps the target its condition holds
 * as it is (`resolveOwnTarget`); any other target is written into the row its condition holds
 * already (§11.2), and a rule the input leaves out is removed with its row (§10.3 "Forward
 * targets").
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
    // Resolved before the writes below, which change a kept condition's row in place.
    const existing = await storedForwardRules(ctx.db, input.id);
    const next = input.rules.map(rule => {
      const held = existing.find(each => each.condition === rule.condition);
      return {
        condition: rule.condition,
        heldId: held?.targetId ?? null,
        ...resolveOwnTarget(ctx, rule.target, held)
      };
    });
    await ctx.db
      .deleteFrom('userForwardRules')
      .where('userId', '=', input.id)
      .execute();
    await deleteForwardTargets(
      ctx.db,
      existing
        .filter(rule => !seenConditions.has(rule.condition))
        .map(rule => rule.targetId)
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
        (await writeTarget(ctx, rule.target, rule.heldId));
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
