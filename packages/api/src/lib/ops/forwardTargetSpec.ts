import type { Transaction } from 'kysely';
import { z } from 'zod';

import {
  DEFAULT_SIP_HEADERS,
  isE164,
  newId,
  type DB,
  type SipHeaderTemplate
} from '@zamfono/shared';

import { noteWarning } from './afterPropagationHooks.js';
import { sipHeadersSchema, udpHeadersWarning } from './sipHeaders.js';
import { OpError, type Context } from './types.js';

const STATUS_NOT_FOUND = 404;

/**
 * A `sip` target's request-URI user part (§9.4 "SIP targets"): RFC 3261's unreserved `.`, `_`,
 * `~`, `-` and the user-unreserved `+` beside letters and digits, a subset that needs no escaping
 * and cannot reach into the `PJSIP/<user>@<endpoint>` dial string; `forward_targets`' CHECK holds
 * the same.
 */
const SIP_USER_PATTERN = /^[A-Za-z0-9._~+-]{1,64}$/u;

/**
 * The shared target vocabulary a ring group's forwarding rule or a menu's fallback/DTMF option
 * points at (§11.2 `forward_targets`). One of the union's variants maps to exactly one of the
 * table's eight exclusive targets, `sip`'s being its column pair.
 */
export const targetSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }),
  z.object({ kind: z.literal('ringGroup'), ringGroupId: z.string() }),
  z.object({
    kind: z.literal('external'),
    external: z.string().refine(isE164, 'external must be E.164')
  }),
  z.object({
    kind: z.literal('sip'),
    trunkId: z.string(),
    user: z
      .string()
      .regex(SIP_USER_PATTERN, 'user must be 1-64 of A-Z a-z 0-9 . _ ~ + -'),
    // §9.4 "Header templates": left out on a write, the defaults, which the write returns as
    // every read does.
    headers: sipHeadersSchema.default(() => [...DEFAULT_SIP_HEADERS])
  }),
  z.object({ kind: z.literal('mailboxUser'), userId: z.string() }),
  z.object({ kind: z.literal('mailboxRingGroup'), ringGroupId: z.string() }),
  z.object({ kind: z.literal('announcement'), audioId: z.string() }),
  z.object({ kind: z.literal('menu'), menuId: z.string() })
]);
export type TargetSpec = z.infer<typeof targetSpecSchema>;

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
  // The table's CHECK sets `sip_user` exactly when `sip_trunk_id` is set, and this module sets
  // `sip_headers_json` with them.
  if (row.sipTrunkId !== null && row.sipUser !== null) {
    return {
      kind: 'sip',
      trunkId: row.sipTrunkId,
      user: row.sipUser,
      headers: JSON.parse(row.sipHeadersJson ?? '[]') as SipHeaderTemplate[]
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

/** Throws 404 when `id` names no live row of `table` (a `forward_targets` column's `RESTRICT` FK). */
async function assertLiveRow(
  db: Transaction<DB>,
  table: 'users' | 'ringGroups' | 'menus' | 'audioAssets' | 'trunks',
  id: string,
  label: string
): Promise<void> {
  const row = await db
    .selectFrom(table)
    .select('id')
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(STATUS_NOT_FOUND, `${label} '${id}' not found`);
  }
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
    await assertLiveRow(db, 'audioAssets', spec.audioId, 'audio asset');
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
