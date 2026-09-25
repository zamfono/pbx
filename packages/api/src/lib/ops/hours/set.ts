import { z } from 'zod';

import { newId } from '@zamfono/shared';

import {
  createTarget,
  resolveTarget,
  targetInputSchema
} from '../dids/_shared.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation, type Context } from '../types.js';
import {
  assertOwnScopeOrAdmin,
  loadIntervals,
  loadSchedule,
  scopeColumns,
  scopeInputSchema,
  validateIntervals,
  type IntervalInput
} from './_shared.js';
import type { HoursWire } from './get.js';

const MAX_WEEKDAY = 7;

const inputSchema = z
  .object({
    scope: scopeInputSchema,
    active: z.boolean().optional(),
    closedTarget: targetInputSchema,
    intervals: z.array(
      z.object({
        weekday: z.number().int().min(1).max(MAX_WEEKDAY),
        opens: z.string(),
        closes: z.string()
      })
    )
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** The `opening_hours_intervals` rows equivalent to `intervals`, so the diff is `JSON`-comparable. */
function intervalsDiff(
  rows: { weekday: number; opens: string; closes: string }[]
): {
  weekday: number;
  opens: string;
  closes: string;
}[] {
  return rows.map(row => ({
    weekday: row.weekday,
    opens: row.opens,
    closes: row.closes
  }));
}

/** Replaces `openingHoursId`'s intervals as a whole with `intervals` (already validated, sorted). */
async function replaceIntervals(
  ctx: Context,
  openingHoursId: string,
  intervals: IntervalInput[]
): Promise<void> {
  await ctx.db
    .deleteFrom('openingHoursIntervals')
    .where('openingHoursId', '=', openingHoursId)
    .execute();
  if (intervals.length > 0) {
    await ctx.db
      .insertInto('openingHoursIntervals')
      .values(
        intervals.map(interval => ({
          openingHoursId,
          weekday: interval.weekday,
          opens: interval.opens,
          closes: interval.closes
        }))
      )
      .execute();
  }
}

/**
 * `PUT /users/{id}/hours`, `/ringGroups/{id}/hours`, `/menus/{id}/hours`, `/tenant/hours` (§10.2
 * "Opening hours"): replaces the scope's schedule and its open intervals as a whole.
 */
export const set = defineOperation<Input, HoursWire>({
  name: 'hours.set',
  description: "Replaces a scope's opening-hours schedule",
  input: inputSchema,
  minRole: 'user',
  entity: (_input, output: HoursWire) => ({
    kind: 'openingHours',
    id: output.id
  }),
  run: async (ctx, input) => {
    assertOwnScopeOrAdmin(ctx.actor, input.scope);
    const intervals = validateIntervals(input.intervals);
    const active = input.active ?? true;
    const closedTargetId = await createTarget(ctx, input.closedTarget);
    const before = await loadSchedule(ctx.db, input.scope);
    const beforeIntervals = before
      ? await loadIntervals(ctx.db, before.id)
      : [];
    const id = before?.id ?? newId();
    if (before) {
      if (active !== (before.active === 1)) {
        recordChange(ctx, {
          field: 'active',
          from: before.active === 1,
          to: active
        });
      }
      recordChange(ctx, {
        field: 'closedTarget',
        from: await resolveTarget(ctx.db, before.closedTargetId),
        to: input.closedTarget
      });
      await ctx.db
        .updateTable('openingHours')
        .set({ active: active ? 1 : 0, closedTargetId })
        .where('id', '=', id)
        .execute();
    } else {
      recordChange(ctx, {
        field: 'closedTarget',
        from: null,
        to: input.closedTarget
      });
      await ctx.db
        .insertInto('openingHours')
        .values({
          id,
          ...scopeColumns(input.scope),
          active: active ? 1 : 0,
          closedTargetId,
          createdAt: ctx.now
        })
        .execute();
    }
    recordChange(ctx, {
      field: 'intervals',
      from: intervalsDiff(beforeIntervals),
      to: intervalsDiff(intervals)
    });
    await replaceIntervals(ctx, id, intervals);
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id,
      scope: input.scope,
      active,
      closedTarget: input.closedTarget,
      intervals
    };
  }
});
