import { sql } from 'kysely';

import { sipUsernameOrFresh } from '../devices/_sipUsername.js';
import { propagate, recordChange } from '../runner.js';
import type { Context } from '../types.js';
import {
  assertExtensionAvailable,
  assertValidExtension,
  userExtension
} from './_extensions.js';

/** A device whose SIP username an extension rename moved, as `users.update` reports it (§9.3). */
export type AffectedDevice = { id: string; sipUsername: string };

/**
 * Renames every live device of `userId` from `e<oldExt>-…` to `e<newExt>-…` and moves the BLF
 * keys watching the extension, in one deferred-FK block: `device_blf_keys.ext` references
 * `extensions.ext` (§11.2), so both statements run under `PRAGMA defer_foreign_keys = ON`, which
 * moves the FK check to commit.
 */
export async function renameExtension(
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
  const renamed: AffectedDevice[] = [];
  for (const device of devices) {
    if (!device.sipUsername.startsWith(oldPrefix)) {
      renamed.push({ id: device.id, sipUsername: device.sipUsername });
      continue;
    }
    const candidate = `e${newExt}-${device.sipUsername.slice(oldPrefix.length)}`;
    // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; renames must serialize
    const sipUsername = await sipUsernameOrFresh(
      ctx.db,
      newExt,
      device.id,
      candidate
    );
    renamed.push({ id: device.id, sipUsername });
  }
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
  for (const device of renamed) {
    // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; renames must serialize
    await ctx.db
      .updateTable('devices')
      .set({ sipUsername: device.sipUsername })
      .where('id', '=', device.id)
      .execute();
  }
  return renamed;
}

/**
 * Renames `input.id`'s extension when `input.extension` names a different one, recording the
 * change and propagating the rendered config; returns the renamed devices, or `undefined` when
 * no rename happened.
 */
export async function maybeRenameExtension(
  ctx: Context,
  input: { id: string; extension?: string }
): Promise<AffectedDevice[] | undefined> {
  if (input.extension === undefined) {
    return undefined;
  }
  const oldExt = await userExtension(ctx.db, input.id);
  if (input.extension === oldExt) {
    return undefined;
  }
  await assertValidExtension(ctx.db, input.extension);
  await assertExtensionAvailable(ctx.db, input.extension);
  const affectedDevices = await renameExtension(
    ctx,
    input.id,
    oldExt,
    input.extension
  );
  // Recorded as `extension`, this operation's own wire field: audit.undo's default field-revert
  // path replays a change under that name through `users.update`, which performs this same
  // rename again to restore it (§5.8).
  recordChange(ctx, { field: 'extension', from: oldExt, to: input.extension });
  if (affectedDevices.length > 0) {
    // `affectedDevices` is not a `users.update` input field, so an undo replay of this entry
    // (which passes each field's `from` value back through this same operation, §5.8) leaves it
    // unread and does nothing with it; the `extension` revert above already renames the devices
    // back on its own. Recorded here only so `GET /audit` lists them alongside the ext change
    // (§9.3 "Naming").
    recordChange(ctx, {
      field: 'affectedDevices',
      from: null,
      to: affectedDevices
    });
  }
  propagate(ctx, ['pjsip', 'dialplan']);
  return affectedDevices;
}
