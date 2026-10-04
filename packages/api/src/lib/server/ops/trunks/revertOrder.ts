import { HTTP_CONFLICT, type ChangeEntry } from '@zamfono/shared';

import { replayOperation } from '../runner.js';
import { Conflict, OpError, type Context } from '../types.js';

/**
 * Reverts one `trunks.setOrder` entry (§5.8) by replaying its recorded `from` order through
 * `trunks.setOrder`. That order names every trunk live at the time; a trunk created or deleted
 * since changes the set the order must name, so the undo is refused with a 409 naming those
 * trunks, and the admin reorders by hand instead.
 */
export async function revertTrunkOrder(
  ctx: Context,
  changes: ChangeEntry[]
): Promise<void> {
  const change = changes.find(candidate => candidate.field === 'trunkIds');
  if (!change) {
    throw new OpError(
      HTTP_CONFLICT,
      "audit.undo: the 'trunks.setOrder' entry records no 'trunkIds'"
    );
  }
  const previous = change.from as string[];
  const live = await ctx.db
    .selectFrom('trunks')
    .select(['id', 'name'])
    .where('deletedAt', 'is', null)
    .execute();
  const liveIds = new Set(live.map(trunk => trunk.id));
  const added = live.filter(trunk => !previous.includes(trunk.id));
  const removed = previous.filter(id => !liveIds.has(id));
  if (added.length > 0 || removed.length > 0) {
    throw new Conflict('the live trunks have changed since this order', [
      ...added.map(trunk => ({
        kind: 'trunk',
        id: trunk.id,
        label: trunk.name
      })),
      ...removed.map(id => ({ kind: 'trunk', id, label: id }))
    ]);
  }
  await replayOperation(ctx, 'trunks.setOrder', { trunkIds: previous });
}
