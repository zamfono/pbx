import { HTTP_CONFLICT } from '@zamfono/shared';

import type { ChangeEntry } from '../audit/_shared.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import { replayOperation } from '../runner.js';
import { scopeFromColumns } from '../scope.js';
import { OpError, type Context } from '../types.js';
import { loadIntervals } from './_shared.js';

/** The entry's recorded change to `field`, or `undefined` where it changed no such field. */
function changeTo(
  changes: ChangeEntry[],
  field: string
): ChangeEntry | undefined {
  return changes.find(change => change.field === field);
}

/**
 * Reverts one `hours.set` entry (§5.8). A schedule is replaced as a whole, so its recorded
 * `active`, `closedTarget` and `intervals` go back together through `hours.set`; a field the entry
 * left alone is read from the row as it stands. Where the entry is the one that first set the
 * schedule (`closedTarget` comes from nothing), the revert removes the schedule through
 * `hours.delete`, the way an undone creation removes the row its `create` inserted.
 */
export async function revertHoursSet(
  ctx: Context,
  entityId: string,
  changes: ChangeEntry[]
): Promise<void> {
  const row = await ctx.db
    .selectFrom('openingHours')
    .selectAll()
    .where('id', '=', entityId)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(
      HTTP_CONFLICT,
      'audit.undo: the opening-hours schedule has been purged'
    );
  }
  const scope = scopeFromColumns(row);
  const closedTarget = changeTo(changes, 'closedTarget');
  if (closedTarget?.from === null) {
    await replayOperation(ctx, 'hours.delete', { scope });
    return;
  }
  const active = changeTo(changes, 'active');
  const intervals = changeTo(changes, 'intervals');
  await replayOperation(ctx, 'hours.set', {
    scope,
    active: active ? active.from : row.active === 1,
    closedTarget: closedTarget
      ? closedTarget.from
      : await resolveTarget(ctx.db, row.closedTargetId),
    intervals: intervals ? intervals.from : await loadIntervals(ctx.db, row.id)
  });
}
