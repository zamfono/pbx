import type { Db, ReloadKind } from '@zamfono/shared';

import { recordChange } from './audit.js';
import { loadDroppedBlfKeys } from './devices/_shared.js';
import { propagate } from './propagate.js';
import { pushRoster } from './roster.js';
import type { Context } from './types.js';
import { moveExtension } from './users/_extensionChange.js';
import {
  assertExtensionAvailable,
  assertValidExtension
} from './users/_extensions.js';

/**
 * An owner of an `extensions` row with no devices of its own (§11.2): a ring group, a decision or a
 * menu. Each has at most one extension, which its own operations give, move and remove alike.
 */
export type ExtensionOwnerRef =
  { ringGroupId: string } | { decisionId: string } | { menuId: string };

type OwnerColumn = 'ringGroupId' | 'decisionId' | 'menuId';

function ownerColumn(owner: ExtensionOwnerRef): [OwnerColumn, string] {
  if ('ringGroupId' in owner) {
    return ['ringGroupId', owner.ringGroupId];
  }
  return 'decisionId' in owner
    ? ['decisionId', owner.decisionId]
    : ['menuId', owner.menuId];
}

/** What a change of `owner`'s extension reloads: a ring group's hints and its mailbox's (§9.3),
 * a decision's or menu's presence hint alone. */
function reloadKinds(owner: ExtensionOwnerRef): ReloadKind[] {
  return 'ringGroupId' in owner ? ['pjsip', 'dialplan'] : ['dialplan'];
}

/** The extension `owner` holds, `null` for none. */
export async function ownedExtension(
  db: Db,
  owner: ExtensionOwnerRef
): Promise<string | null> {
  const [column, id] = ownerColumn(owner);
  const row = await db
    .selectFrom('extensions')
    .select('ext')
    .where(column, '=', id)
    .executeTakeFirst();
  return row?.ext ?? null;
}

/** Gives a newly created `owner` the extension `ext`, recorded as `ext` (§5.8); `null` gives none. */
export async function insertOwnedExtension(
  ctx: Context,
  owner: ExtensionOwnerRef,
  ext: string | null
): Promise<void> {
  if (ext === null) {
    return;
  }
  await assertValidExtension(ctx.db, ext);
  await assertExtensionAvailable(ctx.db, ext);
  await ctx.db
    .insertInto('extensions')
    .values({ ext, ...owner })
    .execute();
  recordChange(ctx, { field: 'ext', from: null, to: ext });
  propagate(ctx, reloadKinds(owner));
  await pushRoster(ctx);
}

/**
 * Gives `owner` the extension `next`, moves it, or removes it (`null`), with the BLF and mailbox
 * keys watching it: a move takes them along, a removal drops them by the FK cascade, as a delete
 * does (§11.2). Recorded under `extension`, the owner's update operation's own field, so audit.undo
 * replays it, then re-inserts the dropped keys (§5.8). `true` when the extension changed.
 */
export async function changeOwnedExtension(
  ctx: Context,
  owner: ExtensionOwnerRef,
  next: string | null | undefined
): Promise<boolean> {
  const current = await ownedExtension(ctx.db, owner);
  if (next === undefined || next === current) {
    return false;
  }
  if (next !== null) {
    await assertValidExtension(ctx.db, next);
    await assertExtensionAvailable(ctx.db, next);
  }
  const droppedBlfKeys =
    next === null && current !== null
      ? await loadDroppedBlfKeys(ctx, current)
      : [];
  const [column, id] = ownerColumn(owner);
  if (next === null) {
    await ctx.db.deleteFrom('extensions').where(column, '=', id).execute();
  } else if (current === null) {
    await ctx.db
      .insertInto('extensions')
      .values({ ext: next, ...owner })
      .execute();
  } else {
    await moveExtension(ctx, current, next);
  }
  recordChange(ctx, { field: 'extension', from: current, to: next });
  if (droppedBlfKeys.length > 0) {
    recordChange(ctx, {
      field: 'droppedBlfKeys',
      from: droppedBlfKeys,
      to: []
    });
  }
  propagate(ctx, reloadKinds(owner));
  return true;
}

/**
 * Deletes `owner`'s extension with its soft delete (§5.9), recorded as `ext` with the BLF keys
 * the FK cascade drops, so undo re-inserts both (§5.8). The extension deleted, `null` for none.
 */
export async function dropOwnedExtension(
  ctx: Context,
  owner: ExtensionOwnerRef
): Promise<string | null> {
  const ext = await ownedExtension(ctx.db, owner);
  if (ext === null) {
    return null;
  }
  const droppedBlfKeys = await loadDroppedBlfKeys(ctx, ext);
  const [column, id] = ownerColumn(owner);
  await ctx.db.deleteFrom('extensions').where(column, '=', id).execute();
  recordChange(ctx, { field: 'ext', from: ext, to: null });
  if (droppedBlfKeys.length > 0) {
    recordChange(ctx, {
      field: 'droppedBlfKeys',
      from: droppedBlfKeys,
      to: []
    });
  }
  propagate(ctx, reloadKinds(owner));
  return ext;
}
