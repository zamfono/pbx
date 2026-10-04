import { sql } from 'kysely';
import { z } from 'zod';

import { recordChange } from '../audit.js';
import { sipUsernameOrFresh } from '../devices/_sipUsername.js';
import { propagate } from '../propagate.js';
import type { Context } from '../types.js';
import {
  assertExtensionAvailable,
  assertValidExtension,
  userExtension
} from './_extensions.js';

/** A device whose SIP username an extension rename moved, as `users.update` reports it (§9.3). */
export const affectedDevice = z.object({
  id: z.string(),
  sipUsername: z.string()
});
export type AffectedDevice = z.infer<typeof affectedDevice>;

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
    // Recorded so `GET /audit` lists the renamed devices alongside the ext change (§9.3
    // "Naming"); undo skips it, since reverting `extension` renames them back.
    recordChange(ctx, {
      field: 'affectedDevices',
      from: null,
      to: affectedDevices
    });
  }
  propagate(ctx, ['pjsip', 'dialplan']);
  return affectedDevices;
}
