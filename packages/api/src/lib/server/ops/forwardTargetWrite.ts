import { newId, type Db } from '@zamfono/shared';

import { webSocketSampleRate, type TargetSpec } from './forwardTargetSchema.js';
import { assertTargetAvailable } from './forwardTargetSpec.js';
import { warnForSipHeaders } from './sipHeaders.js';
import { assertTemplateNames, targetTemplates } from './templateNames.js';
import { type Context } from './types.js';

/** The one column `spec`'s kind sets on its `forward_targets` row, `sip`'s and `webSocket`'s column
 * sets among them and `hangup` none, with a target's `record_calls` and `ring_timeout_s`; every
 * other column stays `null`, but for the announcement any kind may have (`writeForwardTarget`). */
function forwardTargetColumns(
  spec: TargetSpec
): Record<string, string | number | null> {
  if (spec.kind === 'user') {
    return { userId: spec.userId };
  }
  if (spec.kind === 'ringGroup') {
    return { ringGroupId: spec.ringGroupId };
  }
  if (spec.kind === 'external') {
    return {
      external: spec.external,
      recordCalls: spec.record ? 1 : 0,
      ringTimeoutS: spec.ringTimeoutS ?? null
    };
  }
  if (spec.kind === 'sip') {
    return {
      sipTrunkId: spec.trunkId,
      sipUser: spec.user,
      sipHeadersJson: JSON.stringify(spec.headers),
      recordCalls: spec.record ? 1 : 0,
      ringTimeoutS: spec.ringTimeoutS ?? null
    };
  }
  if (spec.kind === 'webSocket') {
    return {
      webSocketProtocol: spec.protocol,
      webSocketUrl: spec.url,
      webSocketSampleRate: webSocketSampleRate(spec),
      recordCalls: spec.record ? 1 : 0
    };
  }
  if (spec.kind === 'mailboxUser') {
    return { mailboxUserId: spec.userId };
  }
  if (spec.kind === 'mailboxRingGroup') {
    return { mailboxRingGroupId: spec.ringGroupId };
  }
  if (spec.kind === 'menu') {
    return { menuId: spec.menuId };
  }
  if (spec.kind === 'decision') {
    return { decisionId: spec.decisionId };
  }
  if (spec.kind === 'extension') {
    return { extension: spec.extension };
  }
  return {};
}

/** Deletes the `forward_targets` rows an operation no longer owns, the targets of rules it
 * removed, each with its fallback chain (`fallback_of_id`'s `ON DELETE CASCADE`). */
export async function deleteForwardTargets(
  db: Db,
  ids: string[]
): Promise<void> {
  if (ids.length > 0) {
    await db.deleteFrom('forwardTargets').where('id', 'in', ids).execute();
  }
}

/**
 * Writes `spec` as one owned `forward_targets` row and returns its id (§11.2): `existingId`, the
 * row its owner holds already, is updated in place, every target column set anew, since rows
 * reference it by its id; without one a row is inserted. Its fallback chain is written the same
 * way, each fallback naming the one before as `fallback_of_id`: the fallback the row has is
 * updated in place, a new one inserted, and one `spec` no longer has deleted, the rest of its
 * chain going with it. A `sip` target's headers too large for its UDP trunk are a warning of the
 * operation's result (§10.3).
 */
export async function writeForwardTarget(
  ctx: Context,
  spec: TargetSpec,
  existingId: string | null,
  fallbackOfId: string | null = null
): Promise<string> {
  const { db } = ctx;
  await assertTargetAvailable(db, spec);
  await assertTemplateNames(db, targetTemplates(spec));
  if (spec.kind === 'sip') {
    await warnForSipHeaders(ctx, spec.trunkId, spec.headers);
  }
  const id = existingId ?? newId();
  const columns = {
    userId: null,
    ringGroupId: null,
    external: null,
    sipTrunkId: null,
    sipUser: null,
    sipHeadersJson: null,
    webSocketProtocol: null,
    webSocketUrl: null,
    webSocketSampleRate: null,
    mailboxUserId: null,
    mailboxRingGroupId: null,
    announcementAudioId: spec.announcementAudioId ?? null,
    menuId: null,
    decisionId: null,
    extension: null,
    ringTimeoutS: null,
    recordCalls: 0,
    ...forwardTargetColumns(spec)
  };
  const held =
    existingId === null
      ? undefined
      : await db
          .selectFrom('forwardTargets')
          .select('id')
          .where('fallbackOfId', '=', existingId)
          .executeTakeFirst();
  if (existingId === null) {
    await db
      .insertInto('forwardTargets')
      .values({ id, fallbackOfId, ...columns })
      .execute();
  } else {
    await db
      .updateTable('forwardTargets')
      .set(columns)
      .where('id', '=', id)
      .execute();
  }
  const fallback = ('fallback' in spec ? spec.fallback : null) ?? null;
  if (fallback !== null) {
    await writeForwardTarget(ctx, fallback, held?.id ?? null, id);
  } else if (held !== undefined) {
    await deleteForwardTargets(db, [held.id]);
  }
  return id;
}
