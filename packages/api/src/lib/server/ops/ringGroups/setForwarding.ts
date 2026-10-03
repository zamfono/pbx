import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import {
  deleteForwardTarget,
  insertForwardTarget,
  liveRingGroup,
  rowToTarget,
  targetSpecSchema
} from './_shared.js';

const forwardingRuleSchema = z.object({
  condition: z
    .enum(['unanswered', 'unavailable'])
    .describe(
      'unanswered: rang and nobody answered; unavailable: no ringable member, fires without ringing and falls to unanswered without this rule.'
    ),
  target: targetSpecSchema
});

export const setRingGroupForwardingInput = z
  .object({
    id: z.string(),
    rules: z
      .array(forwardingRuleSchema)
      .describe(
        "The group's rules, one per condition; without an unanswered rule the call goes to the group's mailbox, else is rejected."
      )
  })
  .strict();

export const setRingGroupForwarding = defineOperation({
  name: 'ringGroups.setForwarding',
  description:
    "Replaces a ring group's 'unanswered' and 'unavailable' forwarding rules as a whole.",
  input: setRingGroupForwardingInput,
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
    const existing = await ctx.db
      .selectFrom('ringGroupForwardRules')
      .select(['condition', 'targetId'])
      .where('groupId', '=', input.id)
      .execute();
    // Resolved before the delete below, since `forwardTargets` rows are gone once it runs.
    const existingRules = await Promise.all(
      existing.map(async rule => ({
        condition: rule.condition,
        target: rowToTarget(
          await ctx.db
            .selectFrom('forwardTargets')
            .selectAll()
            .where('id', '=', rule.targetId)
            .executeTakeFirstOrThrow()
        )
      }))
    );
    await ctx.db
      .deleteFrom('ringGroupForwardRules')
      .where('groupId', '=', input.id)
      .execute();
    for (const rule of existing) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; deletes must serialize
      await deleteForwardTarget(ctx.db, rule.targetId);
    }
    const rows: { groupId: string; condition: string; targetId: string }[] = [];
    for (const rule of input.rules) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; inserts must serialize
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
      from: existingRules,
      to: input.rules
    });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id, rules: input.rules };
  }
});
