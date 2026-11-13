import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { readableTarget } from '../forwardTargets.js';
import { ownTargetSchema } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import {
  assertScopeExists,
  ownScopeInput,
  scopeInputSchema
} from '../scope.js';
import { defineOperation } from '../types.js';
import { intervalSchema, loadIntervals, loadSchedule } from './_shared.js';

const inputSchema = z.object({ scope: scopeInputSchema }).strict();

/** A scope's schedule as `hours.get` returns it and `hours.set` answers with (§10.2 "Opening
 * hours"), an admin-set closed target as its marker to a `user` (§10.3 "Forward targets"). */
export const hoursWire = z.object({
  id: z.string(),
  scope: scopeInputSchema,
  active: z.boolean(),
  closedTarget: ownTargetSchema,
  intervals: z.array(intervalSchema)
});
export type HoursWire = z.infer<typeof hoursWire>;

/**
 * `GET /users/{id}/hours`, `/ringGroups/{id}/hours`, `/menus/{id}/hours`, `/tenant/hours` (§10.2
 * "Opening hours"): the schedule set for that exact scope, or `null` while none is (a scope
 * without its own schedule follows the tenant's at routing time, evaluated in `core`).
 */
export const get = defineOperation({
  name: 'hours.get',
  description: "Reads a scope's opening-hours schedule",
  input: inputSchema,
  output: z.object({ schedule: hoursWire.nullable() }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownScopeInput,
  readOnly: true,
  run: async (ctx, input) => {
    await assertScopeExists(ctx.db, input.scope);
    const schedule = await loadSchedule(ctx.db, input.scope);
    if (!schedule) {
      return { schedule: null };
    }
    const intervals = await loadIntervals(ctx.db, schedule.id);
    const wire: HoursWire = {
      id: schedule.id,
      scope: input.scope,
      active: schedule.active === 1,
      closedTarget: readableTarget(
        ctx,
        await resolveTarget(ctx.db, schedule.closedTargetId)
      ),
      intervals: intervals.map(row => ({
        weekday: row.weekday,
        opens: row.opens,
        closes: row.closes
      }))
    };
    return { schedule: wire };
  }
});
