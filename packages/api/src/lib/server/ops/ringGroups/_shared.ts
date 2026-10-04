import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import {
  emergencyNumbersColumn,
  HTTP_UNPROCESSABLE_CONTENT,
  RING_STRATEGIES,
  type AudioKind,
  type DB
} from '@zamfono/shared';

import { assertAudioOfKind } from '../audio/_shared.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { liveRow } from '../rows.js';
import { logLevelOutputFields, logLevelWire } from '../settings/logLevel.js';
import { OpError } from '../types.js';
import { ringGroupMemberOut, ringGroupMembers } from './_members.js';

/** A `ring_groups` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type RingGroupRow = Selectable<DB['ringGroups']>;

/** Loads a live ring group by id, or throws `OpError(404)`. */
export async function liveRingGroup(
  db: Transaction<DB>,
  id: string
): Promise<RingGroupRow> {
  return liveRow(db, 'ringGroups', id, `ring group '${id}' not found`);
}

const DECIMAL_BASE = 10;

/**
 * Throws 404 when any of a ring group's greeting, MoH or mailbox audio id names no live row, and 422
 * when it names an asset of another kind than its column (§11.2); `null`/`undefined` are skipped
 * (cleared, or left alone) since they need no lookup.
 */
export async function assertGroupAudioFieldsAvailable(
  db: Transaction<DB>,
  fields: {
    greetingAudioId?: string | null;
    mohAudioId?: string | null;
    mailboxAudioId?: string | null;
  }
): Promise<void> {
  const refs: [string | null | undefined, AudioKind][] = [
    [fields.greetingAudioId, 'greeting'],
    [fields.mohAudioId, 'moh'],
    [fields.mailboxAudioId, 'vmGreeting']
  ];
  await Promise.all(
    refs.map(async ([id, kind]) => {
      if (id !== undefined && id !== null) {
        await assertAudioOfKind(db, id, kind);
      }
    })
  );
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
  const emergency = new Set(
    emergencyNumbersColumn.decode(settings.emergencyNumbersJson)
  );
  const max = DECIMAL_BASE ** settings.extLength;
  for (let candidate = 1; candidate < max; candidate += 1) {
    const ext = String(candidate).padStart(settings.extLength, '0');
    if (!used.has(ext) && !emergency.has(ext)) {
      return ext;
    }
  }
  throw new OpError(
    HTTP_UNPROCESSABLE_CONTENT,
    'no free extension left at the tenant extension length'
  );
}

/** Throws 409 when `name` is already used by another live ring group (`ring_groups_name` partial UNIQUE, §11.2). */
export async function assertNameAvailable(
  db: Transaction<DB>,
  name: string,
  excludeId?: string
): Promise<void> {
  await assertNoLiveHolder(
    db,
    'ringGroups: name already in use',
    { table: 'ringGroups', kind: 'ringGroup', label: 'name', values: { name } },
    excludeId
  );
}

/** A ring group's wire shape (§10.3), as `toRingGroupOut` assembles it. */
export const ringGroupOut = z.object({
  id: z.string(),
  name: z.string(),
  ext: z.string(),
  strategy: z.enum(RING_STRATEGIES),
  ringTimeoutS: z.number(),
  ringTotalS: z.number().nullable(),
  skipBusy: z.boolean(),
  allowReject: z.boolean(),
  greetingAudioId: z.string().nullable(),
  mohAudioId: z.string().nullable(),
  recordCalls: z.boolean(),
  mailboxEnabled: z.boolean(),
  mailboxAudioId: z.string().nullable(),
  ...logLevelOutputFields,
  members: z.array(ringGroupMemberOut)
});
export type RingGroupOut = z.infer<typeof ringGroupOut>;

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
    strategy: row.strategy,
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
