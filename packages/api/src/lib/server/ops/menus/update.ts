import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND } from '@zamfono/shared';

import { assertAudioOfKind } from '../audio/_shared.js';
import {
  recordChange,
  recordFieldChanges,
  type WireColumns
} from '../audit.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import { writeForwardTarget } from '../forwardTargetWrite.js';
import { changeOwnedExtension, ownedExtension } from '../ownedExtension.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { defineOperation, type Context } from '../types.js';
import {
  assertNameAvailable,
  liveMenu,
  menuFields,
  menuOut,
  toMenuOut,
  type MenuRow
} from './_shared.js';

export const updateMenuInput = z
  .object({ id: z.string(), ...z.object(menuFields).partial().shape })
  .strict();

/** The row's next scalar values: `input`'s value where given, `before`'s own otherwise. */
function resolvedFields(
  before: MenuRow,
  input: z.infer<typeof updateMenuInput>
): Pick<
  MenuRow,
  'name' | 'audioId' | 'timeoutS' | 'maxAttempts' | 'allowExtensionDialing'
> {
  return {
    name: input.name ?? before.name,
    audioId: input.audioId ?? before.audioId,
    timeoutS: input.timeoutS ?? before.timeoutS,
    maxAttempts: input.maxAttempts ?? before.maxAttempts,
    allowExtensionDialing:
      input.allowExtensionDialing === undefined
        ? before.allowExtensionDialing
        : Number(input.allowExtensionDialing)
  };
}

/** `allowExtensionDialing` is stored as 0/1 and taken as a `boolean` (§11.2, §10.3). */
const WIRE_COLUMNS: WireColumns<MenuRow> = {
  allowExtensionDialing: { decode: Boolean }
};

/** Writes `fallbackTarget`, when given, into the menu's own fallback target row (§11.2). */
async function writeFallbackTarget(
  ctx: Context,
  before: MenuRow,
  fallbackTarget: z.infer<typeof updateMenuInput>['fallbackTarget']
): Promise<void> {
  if (!fallbackTarget) {
    return;
  }
  const previous = await resolveTarget(ctx.db, before.fallbackTargetId);
  await writeForwardTarget(ctx, fallbackTarget, before.fallbackTargetId);
  // The diff names this operation's own input field and carries the wire target, so `audit.undo`
  // replays it straight back through `menus.update` (§5.8).
  recordChange(ctx, {
    field: 'fallbackTarget',
    from: previous,
    to: fallbackTarget
  });
}

export const updateMenu = defineOperation({
  name: 'menus.update',
  description: "Updates a menu's configuration.",
  input: updateMenuInput,
  output: menuOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: input => ({ kind: 'menu', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveMenu(ctx.db, input.id);
    if (input.name !== undefined && input.name !== before.name) {
      await assertNameAvailable(ctx.db, input.name, input.id);
    }
    if (input.audioId !== undefined) {
      await assertAudioOfKind(ctx.db, input.audioId, 'announcement');
    }
    const after = resolvedFields(before, input);
    recordFieldChanges(ctx, before, after, WIRE_COLUMNS);
    await writeFallbackTarget(ctx, before, input.fallbackTarget);
    await ctx.db
      .updateTable('menus')
      .set(after)
      .where('id', '=', input.id)
      .execute();
    const extensionChanged = await changeOwnedExtension(
      ctx,
      { menuId: input.id },
      input.extension
    );
    // The roster lists the extension, titled by the menu's name (§10.4 "Colleague presence").
    if (
      extensionChanged ||
      (after.name !== before.name &&
        (await ownedExtension(ctx.db, { menuId: input.id })) !== null)
    ) {
      await pushRoster(ctx);
    }
    const row = await ctx.db
      .selectFrom('menus')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return toMenuOut(ctx.db, row);
  }
});
