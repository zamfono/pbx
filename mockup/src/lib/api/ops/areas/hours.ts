/**
 * Opening hours (`ops/hours/`, §10.2): one weekly schedule per scope and the target its calls go
 * to while closed. A scope without its own active schedule follows the tenant's. A `user`
 * manages their own user scope only.
 */
import {
  sameScope,
  scheduleStates
} from '#lib/components/schedule-scope/status.js';

import { ApiError, invalid } from '../../errors';
import { newId } from '../../ids';
import type {
  ForwardTarget,
  HoursInterval,
  OpeningHours,
  ScheduleScope
} from '../../types';
import { defineOp } from '../core';
import {
  checkTarget,
  emitTransitions,
  isOwnScope,
  requireScope,
  softDeleteConfirm
} from './ooo';

const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u;
const MAX_WEEKDAY = 7;

/**
 * The rules of `opening_hours_intervals` (`hours/_shared.ts`): weekday 1–7, `HH:MM` bounds
 * (`24:00` the end of the day), `opens < closes` (no interval crosses midnight) and no two
 * intervals sharing `(weekday, opens)`; sorted by weekday, then `opens`.
 */
export function checkIntervals(intervals: HoursInterval[]): HoursInterval[] {
  if (!Array.isArray(intervals)) {
    throw invalid('intervals', 'groups.required', 'intervals is required');
  }
  for (const interval of intervals) {
    if (
      !Number.isInteger(interval.weekday) ||
      interval.weekday < 1 ||
      interval.weekday > MAX_WEEKDAY
    ) {
      throw invalid(
        'intervals',
        'groups.weekday',
        `weekday ${interval.weekday} is not 1-7`,
        { weekday: interval.weekday }
      );
    }
    if (
      !TIME_OF_DAY.test(interval.opens) ||
      !TIME_OF_DAY.test(interval.closes)
    ) {
      throw invalid(
        'intervals',
        'groups.hoursTime',
        `hours: invalid time of day in ${interval.opens}-${interval.closes}`,
        {
          range: `${interval.opens}–${interval.closes}`
        }
      );
    }
    if (!(interval.opens < interval.closes)) {
      throw invalid(
        'intervals',
        'groups.hoursMidnight',
        `hours: interval ${interval.opens}-${interval.closes} crosses midnight`,
        {
          range: `${interval.opens}–${interval.closes}`
        }
      );
    }
  }
  const seen = new Set<string>();
  for (const interval of intervals) {
    const key = `${interval.weekday}:${interval.opens}`;
    if (seen.has(key)) {
      throw invalid(
        'intervals',
        'groups.hoursDuplicate',
        `hours: duplicate interval starting ${interval.opens} on weekday ${interval.weekday}`,
        {
          opens: interval.opens
        }
      );
    }
    seen.add(key);
  }
  return intervals
    .map(({ weekday, opens, closes }) => ({ weekday, opens, closes }))
    .toSorted(
      (left, right) =>
        left.weekday - right.weekday || left.opens.localeCompare(right.opens)
    );
}

const scheduleOf = (
  rows: OpeningHours[],
  scope: ScheduleScope
): OpeningHours | undefined =>
  rows.find(row => row.deletedAt === null && sameScope(row.scope, scope));

defineOp<{ scope: ScheduleScope }, { schedule: OpeningHours | null }>({
  name: 'hours.get',
  minRole: 'user',
  scope: (ctx, input) => isOwnScope(ctx, input.scope),
  readOnly: true,
  run: (ctx, input) => {
    requireScope(ctx.db, input.scope);
    return { schedule: scheduleOf(ctx.db.openingHours, input.scope) ?? null };
  }
});

defineOp<
  {
    scope: ScheduleScope;
    active?: boolean;
    closedTarget: ForwardTarget;
    intervals: HoursInterval[];
  },
  OpeningHours
>({
  name: 'hours.set',
  minRole: 'user',
  scope: (ctx, input) => isOwnScope(ctx, input.scope),
  run: (ctx, input) => {
    requireScope(ctx.db, input.scope);
    const states = scheduleStates(ctx.db);
    const intervals = checkIntervals(input.intervals);
    const active = input.active ?? true;
    const closedTarget = checkTarget(ctx, 'closedTarget', input.closedTarget);
    const existing = scheduleOf(ctx.db.openingHours, input.scope);
    const before = existing === undefined ? null : { ...existing };
    const row: OpeningHours = {
      id: existing?.id ?? newId(),
      scope: input.scope,
      active,
      closedTarget,
      intervals,
      deletedAt: null
    };
    if (existing === undefined) {
      ctx.insert('openingHours', row);
    } else {
      ctx.put('openingHours', row);
    }
    ctx.audit({
      entityKind: 'openingHours',
      entityId: row.id,
      before,
      after: row
    });
    emitTransitions(ctx, states);
    return row;
  }
});

defineOp<{ scope: ScheduleScope }, { id: string }>({
  name: 'hours.delete',
  minRole: 'user',
  scope: (ctx, input) => isOwnScope(ctx, input.scope),
  confirm: (ctx, input) =>
    softDeleteConfirm(
      ctx,
      input.scope.kind === 'tenant' ? 'hours.deleteTenant' : 'hours.delete',
      {
        name: requireScope(ctx.db, input.scope)
      }
    ),
  run: (ctx, input) => {
    requireScope(ctx.db, input.scope);
    const schedule = scheduleOf(ctx.db.openingHours, input.scope);
    if (schedule === undefined) {
      throw new ApiError(
        404,
        'groups.noSchedule',
        'hours: no schedule set for this scope'
      );
    }
    const states = scheduleStates(ctx.db);
    const before = { ...schedule };
    ctx.softDelete('openingHours', schedule.id);
    ctx.audit({
      entityKind: 'openingHours',
      entityId: schedule.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    emitTransitions(ctx, states);
    return { id: schedule.id };
  }
});
