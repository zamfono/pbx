import type { Selectable, Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import { assertAudioAvailable } from '../audio/_shared.js';
import {
  deleteForwardTarget,
  insertForwardTarget,
  rowToTarget,
  targetSpecSchema,
  type TargetSpec
} from '../forwardTargetSpec.js';
import { logLevelWire, type LogLevelColumns } from '../settings/logLevel.js';
import { Conflict, OpError } from '../types.js';
import { ringGroupMembers, type RingGroupMemberOut } from './_members.js';

export {
  targetSpecSchema,
  insertForwardTarget,
  deleteForwardTarget,
  rowToTarget
};
export type { TargetSpec };

/** A `ring_groups` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type RingGroupRow = Selectable<DB['ringGroups']>;

const STATUS_UNPROCESSABLE_ENTITY = 422;
const DECIMAL_BASE = 10;

/**
 * Throws 404 when any of a ring group's greeting, MoH or mailbox audio id names no live row;
 * `null`/`undefined` are skipped (cleared, or left alone) since they need no lookup.
 */
export async function assertGroupAudioFieldsAvailable(
  db: Transaction<DB>,
  fields: {
    greetingAudioId?: string | null;
    mohAudioId?: string | null;
    mailboxAudioId?: string | null;
  }
): Promise<void> {
  const ids = [
    fields.greetingAudioId,
    fields.mohAudioId,
    fields.mailboxAudioId
  ].filter((id): id is string => id !== undefined && id !== null);
  await Promise.all(ids.map(id => assertAudioAvailable(db, id)));
}

/** Maps an optional wire boolean to the `INTEGER 0/1` column value, or `undefined` to keep the column's own default (§11.1). */
export function optionalFlag(value: boolean | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value ? 1 : 0;
}

/** The lowest tenant extension of `settings.ext_length` digits not yet taken or reserved (§11.2). */
export async function nextExtension(db: Transaction<DB>): Promise<string> {
  const settings = await db
    .selectFrom('settings')
    .select(['extLength', 'emergencyNumbersJson'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  const used = new Set(
    (await db.selectFrom('extensions').select('ext').execute()).map(
      row => row.ext
    )
  );
  const emergency = new Set<string>(
    JSON.parse(settings.emergencyNumbersJson) as string[]
  );
  const max = DECIMAL_BASE ** settings.extLength;
  for (let candidate = 1; candidate < max; candidate += 1) {
    const ext = String(candidate).padStart(settings.extLength, '0');
    if (!used.has(ext) && !emergency.has(ext)) {
      return ext;
    }
  }
  throw new OpError(
    STATUS_UNPROCESSABLE_ENTITY,
    'no free extension left at the tenant extension length'
  );
}

/** Throws 409 when `name` is already used by another live ring group (`ring_groups_name` partial UNIQUE, §11.2). */
export async function assertNameAvailable(
  db: Transaction<DB>,
  name: string,
  excludeId?: string
): Promise<void> {
  let query = db
    .selectFrom('ringGroups')
    .select(['id', 'name'])
    .where('name', '=', name)
    .where('deletedAt', 'is', null);
  if (excludeId !== undefined) {
    query = query.where('id', '!=', excludeId);
  }
  const existing = await query.executeTakeFirst();
  if (existing) {
    throw new Conflict('ringGroups: name already in use', [
      { kind: 'ringGroup', id: existing.id, label: existing.name }
    ]);
  }
}

export type RingGroupOut = LogLevelColumns & {
  id: string;
  name: string;
  ext: string;
  strategy: 'simultaneous' | 'sequential' | 'random';
  ringTimeoutS: number;
  ringTotalS: number | null;
  skipBusy: boolean;
  allowReject: boolean;
  greetingAudioId: string | null;
  mohAudioId: string | null;
  recordCalls: boolean;
  mailboxEnabled: boolean;
  mailboxAudioId: string | null;
  members: RingGroupMemberOut[];
};

/** The extension a live ring group owns (§11.2 `extensions`); every live group has exactly one. */
export async function ringGroupExtension(
  db: Transaction<DB>,
  groupId: string
): Promise<string> {
  const row = await db
    .selectFrom('extensions')
    .select('ext')
    .where('ringGroupId', '=', groupId)
    .executeTakeFirstOrThrow();
  return row.ext;
}

/** Assembles the wire shape of a ring group from its row, extension and member list (§10.3). */
export async function toRingGroupOut(
  db: Transaction<DB>,
  row: RingGroupRow
): Promise<RingGroupOut> {
  const [ext, members] = await Promise.all([
    ringGroupExtension(db, row.id),
    ringGroupMembers(db, row.id)
  ]);
  return {
    id: row.id,
    name: row.name,
    ext,
    strategy: row.strategy as RingGroupOut['strategy'],
    ringTimeoutS: row.ringTimeoutS,
    ringTotalS: row.ringTotalS,
    skipBusy: row.skipBusy === 1,
    allowReject: row.allowReject === 1,
    greetingAudioId: row.greetingAudioId,
    mohAudioId: row.mohAudioId,
    recordCalls: row.recordCalls === 1,
    mailboxEnabled: row.mailboxEnabled === 1,
    mailboxAudioId: row.mailboxAudioId,
    ...logLevelWire(row),
    members
  };
}
