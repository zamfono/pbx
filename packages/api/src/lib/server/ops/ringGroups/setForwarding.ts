import {
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  type RingGroupForwardCondition
} from '@zamfono/shared';

import { recordChange } from '../audit.js';
import {
  deleteForwardTargets,
  insertForwardTarget
} from '../forwardTargetSpec.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError } from '../types.js';
import {
  ringGroupForwardingSchema,
  storedRingGroupForwardRules
} from './_forwarding.js';
import { liveRingGroup } from './_shared.js';

export const setRingGroupForwarding = defineOperation({
  name: 'ringGroups.setForwarding',
  description:
    "Replaces a ring group's 'unanswered' and 'unavailable' forwarding rules as a whole.",
  input: ringGroupForwardingSchema,
  output: ringGroupForwardingSchema,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  entity: input => ({ kind: 'ringGroup', id: input.id }),
  run: async (ctx, input) => {
    await liveRingGroup(ctx.db, input.id);
    const seenConditions = new Set<string>();
    for (const rule of input.rules) {
      if (seenConditions.has(rule.condition)) {
        throw new OpError(
          HTTP_UNPROCESSABLE_CONTENT,
          `ringGroups: duplicate forwarding condition '${rule.condition}'`
        );
      }
      seenConditions.add(rule.condition);
    }
    // Read before the delete below, since `forwardTargets` rows are gone once it runs.
    const existing = await storedRingGroupForwardRules(ctx.db, input.id);
    await ctx.db
      .deleteFrom('ringGroupForwardRules')
      .where('groupId', '=', input.id)
      .execute();
    await deleteForwardTargets(
      ctx.db,
      existing.map(rule => rule.targetId)
    );
    const rows: {
      groupId: string;
      condition: RingGroupForwardCondition;
      targetId: string;
    }[] = [];
    for (const rule of input.rules) {
      // eslint-disable-next-line no-await-in-loop -- in input order, so the first invalid target is the one refused and warnings follow the input
      const targetId = await insertForwardTarget(ctx, rule.target);
      rows.push({ groupId: input.id, condition: rule.condition, targetId });
    }
    if (rows.length > 0) {
      await ctx.db.insertInto('ringGroupForwardRules').values(rows).execute();
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
