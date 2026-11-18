import { HTTP_UNPROCESSABLE_CONTENT, isE164 } from '@zamfono/shared';

import { assertAudioOfKind } from '../audio/_shared.js';
import { recordChange } from '../audit.js';
import { writeTarget } from '../forwardTargets.js';
import { type TargetSpec } from '../forwardTargetSchema.js';
import { resolveOptionalTarget } from '../forwardTargetSpec.js';
import { deleteForwardTargets } from '../forwardTargetWrite.js';
import { OpError, type Context } from '../types.js';
import type { SettingsColumns, SettingsRow } from './_shared.js';

/** The `settings.update` fields that name another row, as the helpers below read them. */
type ReferenceFieldInput = {
  mainDidId?: string;
  holdMohAudioId?: string | null;
  fallbackTarget?: TargetSpec | null;
};

/** Validates `mainDidId` is a live, numeric DID (§9.4 "Caller-ID") before applying it. */
export async function applyMainDidId(
  ctx: Context,
  before: SettingsRow,
  input: ReferenceFieldInput,
  columns: SettingsColumns
): Promise<void> {
  if (input.mainDidId === undefined || input.mainDidId === before.mainDidId) {
    return;
  }
  const did = await ctx.db
    .selectFrom('dids')
    .select(['id', 'number'])
    .where('id', '=', input.mainDidId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!did || !isE164(did.number)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'settings: mainDidId must be a live numeric DID'
    );
  }
  recordChange(ctx, {
    field: 'mainDidId',
    from: before.mainDidId,
    to: input.mainDidId
  });
  columns.mainDidId = input.mainDidId;
}

/** Validates `holdMohAudioId` is a live `moh` audio asset (§11.4, 404/422) before applying it. */
export async function applyHoldMohAudioId(
  ctx: Context,
  before: SettingsRow,
  input: ReferenceFieldInput,
  columns: SettingsColumns
): Promise<void> {
  if (
    input.holdMohAudioId === undefined ||
    input.holdMohAudioId === before.holdMohAudioId
  ) {
    return;
  }
  if (input.holdMohAudioId !== null) {
    await assertAudioOfKind(ctx.db, input.holdMohAudioId, 'moh');
  }
  recordChange(ctx, {
    field: 'holdMohAudioId',
    from: before.holdMohAudioId,
    to: input.holdMohAudioId
  });
  columns.holdMohAudioId = input.holdMohAudioId;
}

/** Writes `fallbackTarget` when given, into the forward-target row the settings hold or a new
 * one where they hold none; `null` clears the column and deletes the row (§11.2, §11.3). */
export async function applyFallbackTarget(
  ctx: Context,
  before: SettingsRow,
  input: ReferenceFieldInput,
  columns: SettingsColumns
): Promise<void> {
  if (input.fallbackTarget === undefined) {
    return;
  }
  // The wire target, not the row id: undo replays `from` through `settings.update` (§5.8). Read
  // before the write, which changes the row in place.
  recordChange(ctx, {
    field: 'fallbackTarget',
    from: await resolveOptionalTarget(ctx.db, before.fallbackTargetId),
    to: input.fallbackTarget
  });
  if (input.fallbackTarget !== null) {
    columns.fallbackTargetId = await writeTarget(
      ctx,
      input.fallbackTarget,
      before.fallbackTargetId
    );
    return;
  }
  columns.fallbackTargetId = null;
  if (before.fallbackTargetId !== null) {
    // The column lets go of the row before it is deleted (`ON DELETE RESTRICT`).
    await ctx.db
      .updateTable('settings')
      .set({ fallbackTargetId: null })
      .where('id', '=', 1)
      .execute();
    await deleteForwardTargets(ctx.db, [before.fallbackTargetId]);
  }
}
