import type { Transaction } from 'kysely';

import { newId, sipHeadersColumn, type Db, type DB } from '@zamfono/shared';

import { noteWarning } from './afterCommit.js';
import { assertAudioOfKind } from './audio/_shared.js';
import type { TargetSpec } from './forwardTargetSchema.js';
import { liveRow } from './rows.js';
import { udpHeadersWarning } from './sipHeaders.js';
import { type Context } from './types.js';

/** The one column `spec` sets on its `forward_targets` row; every other column stays `null`. */
function forwardTargetColumns(spec: TargetSpec): Record<string, string> {
  if (spec.kind === 'user') {
    return { userId: spec.userId };
  }
  if (spec.kind === 'ringGroup') {
    return { ringGroupId: spec.ringGroupId };
  }
  if (spec.kind === 'external') {
    return { external: spec.external };
  }
  if (spec.kind === 'sip') {
    return {
      sipTrunkId: spec.trunkId,
      sipUser: spec.user,
      sipHeadersJson: JSON.stringify(spec.headers)
    };
  }
  if (spec.kind === 'mailboxUser') {
    return { mailboxUserId: spec.userId };
  }
  if (spec.kind === 'mailboxRingGroup') {
    return { mailboxRingGroupId: spec.ringGroupId };
  }
  if (spec.kind === 'announcement') {
    return { announcementAudioId: spec.audioId };
  }
  return { menuId: spec.menuId };
}

type ForwardTargetColumns = {
  userId: string | null;
  ringGroupId: string | null;
  external: string | null;
  sipTrunkId: string | null;
  sipUser: string | null;
  sipHeadersJson: string | null;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  announcementAudioId: string | null;
  menuId: string | null;
};

/** The inverse of `forwardTargetColumns`: the wire target a `forward_targets` row represents. */
export function rowToTarget(row: ForwardTargetColumns): TargetSpec {
  if (row.userId !== null) {
    return { kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  if (row.external !== null) {
    return { kind: 'external', external: row.external };
  }
  // The table's CHECKs set `sip_user` and `sip_headers_json` exactly when `sip_trunk_id` is set.
  if (
    row.sipTrunkId !== null &&
    row.sipUser !== null &&
    row.sipHeadersJson !== null
  ) {
    return {
      kind: 'sip',
      trunkId: row.sipTrunkId,
      user: row.sipUser,
      headers: sipHeadersColumn.decode(row.sipHeadersJson)
    };
  }
  if (row.mailboxUserId !== null) {
    return { kind: 'mailboxUser', userId: row.mailboxUserId };
  }
  if (row.mailboxRingGroupId !== null) {
    return { kind: 'mailboxRingGroup', ringGroupId: row.mailboxRingGroupId };
  }
  if (row.announcementAudioId !== null) {
    return { kind: 'announcement', audioId: row.announcementAudioId };
  }
  if (row.menuId !== null) {
    return { kind: 'menu', menuId: row.menuId };
  }
  throw new Error('forwardTargets: row has no owner column set');
}

/** Loads and converts the `forward_targets` row `targetId` points at; `targetId` is never NULL. */
export async function resolveTarget(
  db: Db,
  targetId: string
): Promise<TargetSpec> {
  const row = await db
    .selectFrom('forwardTargets')
    .selectAll()
    .where('id', '=', targetId)
    .executeTakeFirstOrThrow();
  return rowToTarget(row);
}

/** `resolveTarget`, but for a nullable FK such as `did_blocks.fallback_target_id`. */
export async function resolveOptionalTarget(
  db: Db,
  targetId: string | null
): Promise<TargetSpec | null> {
  return targetId === null ? null : resolveTarget(db, targetId);
}

/** Throws 404 when `id` names no live row of `table` (a `forward_targets` column's `RESTRICT` FK). */
async function assertLiveRow(
  db: Transaction<DB>,
  table: 'users' | 'ringGroups' | 'menus' | 'audioAssets' | 'trunks',
  id: string,
  label: string
): Promise<void> {
  await liveRow(db, table, id, `${label} '${id}' not found`);
}

/**
 * Throws 404 when `spec`'s referenced id names no live row (§5.9: routing never depends on a
 * soft-deleted row, so a rule can only ever target one); `external` names no row and needs none.
 */
async function assertTargetAvailable(
  db: Transaction<DB>,
  spec: TargetSpec
): Promise<void> {
  if (spec.kind === 'user' || spec.kind === 'mailboxUser') {
    await assertLiveRow(db, 'users', spec.userId, 'user');
    return;
  }
  if (spec.kind === 'ringGroup' || spec.kind === 'mailboxRingGroup') {
    await assertLiveRow(db, 'ringGroups', spec.ringGroupId, 'ring group');
    return;
  }
  if (spec.kind === 'announcement') {
    await assertAudioOfKind(db, spec.audioId, 'announcement');
    return;
  }
  if (spec.kind === 'menu') {
    await assertLiveRow(db, 'menus', spec.menuId, 'menu');
    return;
  }
  if (spec.kind === 'sip') {
    await assertLiveRow(db, 'trunks', spec.trunkId, 'trunk');
  }
}

/** Notes the warning a `sip` target's headers get over its trunk on `ctx`'s result (§10.3). */
async function warnForSipHeaders(
  ctx: Context,
  spec: Extract<TargetSpec, { kind: 'sip' }>
): Promise<void> {
  const trunk = await ctx.db
    .selectFrom('trunks')
    .select(['name', 'transport'])
    .where('id', '=', spec.trunkId)
    .executeTakeFirstOrThrow();
  const warning = udpHeadersWarning(spec.headers, trunk);
  if (warning !== null) {
    noteWarning(ctx, warning);
  }
}

/** Inserts one owned `forward_targets` row for `spec`, returning its id (§11.2); a `sip` target's
 * headers too large for its UDP trunk are a warning of the operation's result (§10.3). */
export async function insertForwardTarget(
  ctx: Context,
  spec: TargetSpec
): Promise<string> {
  const { db } = ctx;
  await assertTargetAvailable(db, spec);
  if (spec.kind === 'sip') {
    await warnForSipHeaders(ctx, spec);
  }
  const id = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id,
      userId: null,
      ringGroupId: null,
      external: null,
      sipTrunkId: null,
      sipUser: null,
      sipHeadersJson: null,
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null,
      ...forwardTargetColumns(spec)
    })
    .execute();
  return id;
}

/** Deletes a `forward_targets` row an operation no longer owns, e.g. one it is about to replace. */
export async function deleteForwardTarget(
  db: Transaction<DB>,
  id: string
): Promise<void> {
  await db.deleteFrom('forwardTargets').where('id', '=', id).execute();
}
