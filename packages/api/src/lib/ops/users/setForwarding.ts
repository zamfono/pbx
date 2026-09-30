import { z } from 'zod';

import { rowToTarget } from '../forwardTargetSpec.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import {
  createTarget,
  deleteTargetIfOrphan,
  liveUser,
  targetInputSchema
} from './_shared.js';

const STATUS_UNPROCESSABLE_ENTITY = 422;

/** §11.2 `user_forward_rules` CHECK: the classic CFU/CFB/CFNR conditions plus presence-aware ones. */
const CONDITIONS = [
  'unconditional',
  'busy',
  'noAnswer',
  'dnd',
  'offline'
] as const;

const inputSchema = z
  .object({
    id: z.string(),
    rules: z.array(
      z.object({ condition: z.enum(CONDITIONS), target: targetInputSchema })
    )
  })
  .strict();

/** `PUT /users/{id}/forwarding` (§10.3, §11.2): replaces a user's forwarding rules as a whole. */
export const setForwarding = defineOperation({
  name: 'users.setForwarding',
  description: "Replaces a user's call-forwarding rules as a whole.",
  input: inputSchema,
  minRole: 'admin',
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    await liveUser(ctx.db, input.id);
    const seenConditions = new Set<string>();
    for (const rule of input.rules) {
      if (seenConditions.has(rule.condition)) {
        throw new OpError(
          STATUS_UNPROCESSABLE_ENTITY,
          `users: duplicate forwarding condition '${rule.condition}'`
        );
      }
      seenConditions.add(rule.condition);
    }
    const existing = await ctx.db
      .selectFrom('userForwardRules')
      .select(['condition', 'targetId'])
      .where('userId', '=', input.id)
      .execute();
    // Resolved before the delete below, since `forward_targets` rows are gone once it runs.
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
      .deleteFrom('userForwardRules')
      .where('userId', '=', input.id)
      .execute();
    for (const rule of existing) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; deletes must serialize
      await deleteTargetIfOrphan(ctx, rule.targetId);
    }
    const rows: { userId: string; condition: string; targetId: string }[] = [];
    for (const rule of input.rules) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; inserts must serialize
      const targetId = await createTarget(ctx, rule.target);
      rows.push({ userId: input.id, condition: rule.condition, targetId });
    }
    if (rows.length > 0) {
      await ctx.db.insertInto('userForwardRules').values(rows).execute();
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
