import { HTTP_UNPROCESSABLE_CONTENT, isE164 } from '@zamfono/shared';

import { assertAudioOfKind } from '../audio/_shared.js';
import { recordChange } from '../audit.js';
import { createTarget } from '../forwardTargets.js';
import { type TargetSpec } from '../forwardTargetSchema.js';
import { resolveOptionalTarget } from '../forwardTargetSpec.js';
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

/** Creates a new forward-target row for `fallbackTarget` when given (§11.3, like `dids.update`). */
export async function applyFallbackTarget(
  ctx: Context,
  before: SettingsRow,
  input: ReferenceFieldInput,
  columns: SettingsColumns
): Promise<void> {
  if (input.fallbackTarget === undefined) {
    return;
  }
  const targetId = input.fallbackTarget
    ? await createTarget(ctx, input.fallbackTarget)
    : null;
  // The wire target, not the row id: undo replays `from` through `settings.update` (§5.8).
  recordChange(ctx, {
    field: 'fallbackTarget',
    from: await resolveOptionalTarget(ctx.db, before.fallbackTargetId),
    to: input.fallbackTarget
  });
  columns.fallbackTargetId = targetId;
}
