import {
  createTarget,
  resolveOptionalTarget,
  type TargetInput
} from '../dids/_shared.js';
import { recordChange } from '../runner.js';
import { OpError, type Context } from '../types.js';
import type { SettingsRow } from './_shared.js';

const STATUS_UNPROCESSABLE_ENTITY = 422;

/** The `+` and digits shape of a numeric DID (§9.4 "Caller-ID"): only such a DID may be presented. */
const NUMERIC_NUMBER = /^\+[0-9]+$/u;
const MOH_KIND = 'moh';

/** The `settings.update` fields that name another row, as the helpers below read them. */
type ReferenceFieldInput = {
  mainDidId?: string;
  holdMohAudioId?: string | null;
  fallbackTarget?: TargetInput | null;
};

/** Validates `mainDidId` is a live, numeric DID (§9.4 "Caller-ID") before applying it. */
export async function applyMainDidId(
  ctx: Context,
  before: SettingsRow,
  input: ReferenceFieldInput,
  columns: Record<string, unknown>
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
  if (!did || !NUMERIC_NUMBER.test(did.number)) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
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

/** Validates `holdMohAudioId` is a live `moh` audio asset (§11.4) before applying it. */
export async function applyHoldMohAudioId(
  ctx: Context,
  before: SettingsRow,
  input: ReferenceFieldInput,
  columns: Record<string, unknown>
): Promise<void> {
  if (
    input.holdMohAudioId === undefined ||
    input.holdMohAudioId === before.holdMohAudioId
  ) {
    return;
  }
  const audio =
    input.holdMohAudioId === null
      ? undefined
      : await ctx.db
          .selectFrom('audioAssets')
          .select('id')
          .where('id', '=', input.holdMohAudioId)
          .where('kind', '=', MOH_KIND)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
  if (input.holdMohAudioId !== null && !audio) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      "settings: holdMohAudioId must be a live 'moh' audio asset"
    );
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
  columns: Record<string, unknown>
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
