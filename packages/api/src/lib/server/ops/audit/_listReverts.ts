import { HTTP_CONFLICT, type ChangeEntry } from '@zamfono/shared';

import { replayOperation } from '../runner.js';
import { revertTrunkOrder } from '../trunks/revertOrder.js';
import { OpError, type Context } from '../types.js';

/** Reverts one entry of an entity, given the entity's id and the entry's recorded changes. */
export type EntryRevert = (
  ctx: Context,
  entityId: string,
  changes: ChangeEntry[]
) => Promise<void>;

/**
 * The reverter of `operation`, a whole-list replace of one entity's list that records the list as
 * the single field `field`, in the operation's own input shape under `inputField`: the recorded
 * `from` list goes back through that same operation, as one replace (§5.8: "Field changes are
 * reverted by writing the `from` values back through the normal operations").
 */
function replayList(
  operation: string,
  field: string,
  inputField: string = field
): EntryRevert {
  return async (ctx, entityId, changes) => {
    const change = changes.find(candidate => candidate.field === field);
    if (!change) {
      throw new OpError(
        HTTP_CONFLICT,
        `audit.undo: the '${operation}' entry records no '${field}'`
      );
    }
    await replayOperation(ctx, operation, {
      id: entityId,
      [inputField]: change.from
    });
  };
}

/**
 * The whole-list replaces of one entity's list (§10.3): forwarding rules, a menu's DTMF map and a
 * device's BLF panel. None is among §5.8's non-undoable cases, and each records the full `from`
 * list, so each is undone by replaying that list.
 */
export const LIST_REVERTS: Partial<Record<string, EntryRevert>> = {
  'users.setForwarding': replayList('users.setForwarding', 'rules'),
  'ringGroups.setForwarding': replayList('ringGroups.setForwarding', 'rules'),
  'menus.setTargets': replayList('menus.setTargets', 'targets'),
  'devices.setBlf': replayList('devices.setBlf', 'blfKeys', 'keys')
};

/** Reverts one entry of a tenant-wide list, given the entry's recorded changes. */
type TenantListRevert = (ctx: Context, changes: ChangeEntry[]) => Promise<void>;

/**
 * The replaces of a tenant-wide list, recorded with no entity id since the list as a whole is the
 * entity: the outbound routes in evaluation order and the trunk order (§9.4). Each records its
 * full `from` list in its own input shape and is none of §5.8's non-undoable cases.
 */
const TENANT_LIST_REVERTS: Partial<Record<string, TenantListRevert>> = {
  'outboundRoutes.replace': async (ctx, changes) => {
    const routes = changes.find(change => change.field === 'routes');
    await replayOperation(ctx, 'outboundRoutes.replace', {
      routes: routes?.from
    });
  },
  'trunks.setOrder': revertTrunkOrder
};

/** Whether `operation` records a tenant-wide list that `revertTenantList` can take back. */
export function isTenantListOperation(operation: string): boolean {
  return TENANT_LIST_REVERTS[operation] !== undefined;
}

/** Reverts one tenant-wide list replace through the operation that wrote it (§5.8). */
export async function revertTenantList(
  ctx: Context,
  operation: string,
  changes: ChangeEntry[]
): Promise<void> {
  const revert = TENANT_LIST_REVERTS[operation];
  if (!revert) {
    throw new OpError(
      HTTP_CONFLICT,
      `audit.undo: operation '${operation}' has no single row to revert`
    );
  }
  await revert(ctx, changes);
}
