import {
  isWebSocketSampleRate,
  sipHeadersColumn,
  type Db,
  type WebSocketProtocol,
  type WebSocketSampleRate
} from '@zamfono/shared';

import { readAfterCall } from './afterCall.js';
import type { TargetSpec } from './forwardTargetSchema.js';

type ForwardTargetColumns = {
  id: string;
  userId: string | null;
  ringGroupId: string | null;
  external: string | null;
  sipTrunkId: string | null;
  sipUser: string | null;
  sipHeadersJson: string | null;
  webSocketProtocol: WebSocketProtocol | null;
  webSocketUrl: string | null;
  webSocketSampleRate: number | null;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  announcementAudioId: string | null;
  menuId: string | null;
  decisionId: string | null;
  extension: string | null;
  ringTimeoutS: number | null;
  recordCalls: number;
};

/** A `webSocket` target's stored sample rate, one of those the table's CHECK allows. */
function storedSampleRate(rate: number | null): WebSocketSampleRate {
  if (isWebSocketSampleRate(rate)) {
    return rate;
  }
  throw new Error(`forwardTargets: web socket sample rate ${String(rate)}`);
}

/** The inverse of `forwardTargetColumns`: the wire target a `forward_targets` row represents,
 * `hangup` for none of the ten targets set (§11.2), `fallback` still `null` (`rowToTarget`). */
function baseTarget(row: ForwardTargetColumns): TargetSpec {
  if (row.userId !== null) {
    return { kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  if (row.external !== null) {
    return {
      kind: 'external',
      external: row.external,
      ringTimeoutS: row.ringTimeoutS,
      record: row.recordCalls === 1,
      fallback: null
    };
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
      headers: sipHeadersColumn.decode(row.sipHeadersJson),
      ringTimeoutS: row.ringTimeoutS,
      record: row.recordCalls === 1,
      fallback: null
    };
  }
  // The table's CHECKs set the three `web_socket_*` columns together, 8000 for `twilio`.
  if (row.webSocketUrl !== null && row.webSocketProtocol !== null) {
    return {
      kind: 'webSocket',
      protocol: row.webSocketProtocol,
      url: row.webSocketUrl,
      sampleRate: storedSampleRate(row.webSocketSampleRate),
      record: row.recordCalls === 1,
      fallback: null
    };
  }
  if (row.mailboxUserId !== null) {
    return { kind: 'mailboxUser', userId: row.mailboxUserId };
  }
  if (row.mailboxRingGroupId !== null) {
    return { kind: 'mailboxRingGroup', ringGroupId: row.mailboxRingGroupId };
  }
  if (row.menuId !== null) {
    return { kind: 'menu', menuId: row.menuId };
  }
  if (row.decisionId !== null) {
    return { kind: 'decision', decisionId: row.decisionId };
  }
  if (row.extension !== null) {
    return { kind: 'extension', extension: row.extension, fallback: null };
  }
  return { kind: 'hangup' };
}

/** The wire target a `forward_targets` row represents, with its fallback chain, the rows whose
 * `fallback_of_id` names it, each the next one's (§10.1 step 7). */
export async function rowToTarget(
  db: Db,
  row: ForwardTargetColumns
): Promise<TargetSpec> {
  const target = {
    ...baseTarget(row),
    announcementAudioId: row.announcementAudioId
  };
  if (!('fallback' in target)) {
    return target;
  }
  if (target.kind !== 'extension') {
    target.afterCall = await readAfterCall(db, row.id);
  }
  const fallback = await db
    .selectFrom('forwardTargets')
    .selectAll()
    .where('fallbackOfId', '=', row.id)
    .executeTakeFirst();
  return fallback === undefined
    ? target
    : { ...target, fallback: await rowToTarget(db, fallback) };
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
  return rowToTarget(db, row);
}

/** `resolveTarget`, but for a nullable FK such as `did_blocks.fallback_target_id`. */
export async function resolveOptionalTarget(
  db: Db,
  targetId: string | null
): Promise<TargetSpec | null> {
  return targetId === null ? null : resolveTarget(db, targetId);
}
