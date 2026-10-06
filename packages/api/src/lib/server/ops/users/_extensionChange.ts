import { sql } from 'kysely';
import { z } from 'zod';

import type { Db } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { loadDroppedBlfKeys, type DroppedBlfKey } from '../devices/_shared.js';
import { sipUsernameOrFresh } from '../devices/_sipUsername.js';
import { propagate } from '../propagate.js';
import { Conflict, type Context } from '../types.js';
import {
  assertExtensionAvailable,
  assertValidExtension
} from './_extensions.js';

/** A device whose SIP username an extension rename moved, as `users.update` reports it (§9.3). */
export const affectedDevice = z.object({
  id: z.string(),
  sipUsername: z.string()
});
export type AffectedDevice = z.infer<typeof affectedDevice>;

/** A user's extension going from `from` to `to`, `null` for none; a removal carries the BLF keys
 *  watching it, which the FK cascade drops, so the audit diff can restore them (§5.9). */
export type ExtensionChange = {
  from: string | null;
  to: string | null;
  droppedBlfKeys: DroppedBlfKey[];
};

/**
 * Renames every live device of `userId` from `e<oldExt>-…` to `e<newExt>-…` and moves the BLF
 * keys watching the extension, in one deferred-FK block: `device_blf_keys.ext` references
 * `extensions.ext` (§11.2), so both statements run under `PRAGMA defer_foreign_keys = ON`, which
 * moves the FK check to commit.
 */
async function renameExtension(
  ctx: Context,
  userId: string,
  oldExt: string,
  newExt: string
): Promise<AffectedDevice[]> {
  const devices = await ctx.db
    .selectFrom('devices')
    .select(['id', 'sipUsername'])
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null)
    .execute();
  const oldPrefix = `e${oldExt}-`;
  const renamed: AffectedDevice[] = await Promise.all(
    devices.map(async device => ({
      id: device.id,
      sipUsername: device.sipUsername.startsWith(oldPrefix)
        ? await sipUsernameOrFresh(
            ctx.db,
            newExt,
            device.id,
            `e${newExt}-${device.sipUsername.slice(oldPrefix.length)}`
          )
        : device.sipUsername
    }))
  );
  await sql`PRAGMA defer_foreign_keys = ON`.execute(ctx.db);
  await ctx.db
    .updateTable('deviceBlfKeys')
    .set({ ext: newExt })
    .where('ext', '=', oldExt)
    .execute();
  await ctx.db
    .updateTable('extensions')
    .set({ ext: newExt })
    .where('ext', '=', oldExt)
    .execute();
  await Promise.all(
    renamed.map(device =>
      ctx.db
        .updateTable('devices')
        .set({ sipUsername: device.sipUsername })
        .where('id', '=', device.id)
        .execute()
    )
  );
  return renamed;
}

/**
 * Throws `Conflict(409)` naming what keeps `userId` from losing their extension (§11.2): their
 * live devices, which are named after it, and the live ring groups they are a member of.
 */
async function assertExtensionRemovable(db: Db, userId: string): Promise<void> {
  const devices = await db
    .selectFrom('devices')
    .select(['id', 'label'])
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null)
    .execute();
  if (devices.length > 0) {
    throw new Conflict(
      "users: the extension names the user's devices; remove them first",
      devices.map(device => ({
        kind: 'device',
        id: device.id,
        label: device.label
      }))
    );
  }
  const groups = await db
    .selectFrom('ringGroupMembers')
    .innerJoin('ringGroups', 'ringGroups.id', 'ringGroupMembers.groupId')
    .select(['ringGroups.id', 'ringGroups.name'])
    .where('ringGroupMembers.userId', '=', userId)
    .where('ringGroups.deletedAt', 'is', null)
    .execute();
  if (groups.length > 0) {
    throw new Conflict(
      'users: the user is a member of ring groups; remove them first',
      groups.map(group => ({
        kind: 'ringGroup',
        id: group.id,
        label: group.name
      }))
    );
  }
}

/**
 * The change `next` asks of `userId`'s extension `current`, checked: a new extension must be
 * valid and free, a removal must be possible (`assertExtensionRemovable`). `undefined` when
 * `next` is absent or names the extension the user already has.
 */
export async function planExtensionChange(
  ctx: Context,
  userId: string,
  current: string | null,
  next: string | null | undefined
): Promise<ExtensionChange | undefined> {
  if (next === undefined || next === current) {
    return undefined;
  }
  if (next === null) {
    await assertExtensionRemovable(ctx.db, userId);
  } else {
    await assertValidExtension(ctx.db, next);
    await assertExtensionAvailable(ctx.db, next);
  }
  return {
    from: current,
    to: next,
    droppedBlfKeys:
      next === null && current !== null
        ? await loadDroppedBlfKeys(ctx, current)
        : []
  };
}

/** Writes `change` and propagates the rendered config; returns the devices a rename renamed. */
async function applyExtensionChange(
  ctx: Context,
  userId: string,
  change: ExtensionChange
): Promise<AffectedDevice[]> {
  propagate(ctx, ['pjsip', 'dialplan']);
  if (change.to === null) {
    await ctx.db
      .deleteFrom('extensions')
      .where('userId', '=', userId)
      .execute();
    return [];
  }
  if (change.from === null) {
    await ctx.db
      .insertInto('extensions')
      .values({ ext: change.to, userId })
      .execute();
    return [];
  }
  return renameExtension(ctx, userId, change.from, change.to);
}

/** Records `change` under `extension`, `users.update`'s own wire field, so audit.undo's field
 *  revert replays it through `users.update` (§5.8), with the BLF keys a removal dropped. */
function recordExtensionChange(
  ctx: Context,
  change: ExtensionChange,
  affectedDevices: AffectedDevice[]
): void {
  recordChange(ctx, { field: 'extension', from: change.from, to: change.to });
  if (affectedDevices.length > 0) {
    // Lists the renamed devices in `GET /audit` alongside the change (§9.3 "Naming"); undo skips
    // it, since reverting `extension` renames them back.
    recordChange(ctx, {
      field: 'affectedDevices',
      from: null,
      to: affectedDevices
    });
  }
  if (change.droppedBlfKeys.length > 0) {
    recordChange(ctx, {
      field: 'droppedBlfKeys',
      from: change.droppedBlfKeys,
      to: []
    });
  }
}

/**
 * Applies `change`, if any, around `writeRow`, the UPDATE of the user's row with its audit
 * fields; returns the devices it renamed, `undefined` without a change. The e-mail-or-extension
 * rule (§11.2) holds after every statement, which its triggers check, and after every step of an
 * undo, which replays the diff in order: an extension that goes leaves after the row's new e-mail
 * has landed and is recorded before it; one that comes or moves arrives before the row's e-mail
 * may go and is recorded after it.
 */
export async function withExtensionChange(
  ctx: Context,
  userId: string,
  change: ExtensionChange | undefined,
  writeRow: () => Promise<void>
): Promise<AffectedDevice[] | undefined> {
  if (change === undefined) {
    await writeRow();
    return undefined;
  }
  if (change.to === null) {
    recordExtensionChange(ctx, change, []);
    await writeRow();
    return applyExtensionChange(ctx, userId, change);
  }
  const affectedDevices = await applyExtensionChange(ctx, userId, change);
  await writeRow();
  recordExtensionChange(ctx, change, affectedDevices);
  return affectedDevices;
}
