import { z } from 'zod';

import { type TargetSpec } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import {
  assertOwnScopeOrAdmin,
  scopeInputSchema,
  type ScopeInput
} from '../scope.js';
import { defineOperation } from '../types.js';
import { loadIntervals, loadSchedule, type IntervalInput } from './_shared.js';

const inputSchema = z.object({ scope: scopeInputSchema }).strict();

export type HoursWire = {
  id: string;
  scope: ScopeInput;
  active: boolean;
  closedTarget: TargetSpec;
  intervals: IntervalInput[];
};

/**
 * `GET /users/{id}/hours`, `/ringGroups/{id}/hours`, `/menus/{id}/hours`, `/tenant/hours` (§10.2
 * "Opening hours"): the schedule set for that exact scope, or `null` while none is (a scope
 * without its own schedule follows the tenant's at routing time, evaluated in `core`).
 */
export const get = defineOperation({
  name: 'hours.get',
  description: "Reads a scope's opening-hours schedule",
  input: inputSchema,
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    assertOwnScopeOrAdmin(ctx.actor, input.scope);
    const schedule = await loadSchedule(ctx.db, input.scope);
    if (!schedule) {
      return { schedule: null };
    }
    const intervals = await loadIntervals(ctx.db, schedule.id);
    const wire: HoursWire = {
      id: schedule.id,
      scope: input.scope,
      active: schedule.active === 1,
      closedTarget: await resolveTarget(ctx.db, schedule.closedTargetId),
      intervals: intervals.map(row => ({
        weekday: row.weekday,
        opens: row.opens,
        closes: row.closes
      }))
    };
    return { schedule: wire };
  }
});
