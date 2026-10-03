import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  isE164,
  type DB
} from '@zamfono/shared';

import { assertNoLiveHolder } from '../liveHolder.js';
import { logLevelWire, type LogLevelColumns } from '../settings/logLevel.js';
import { OpError, type Role } from '../types.js';
import { accountLockedUntil } from './_accountLock.js';
import { userExtension } from './_extensions.js';

export {
  createTarget,
  deleteTargetIfOrphan,
  targetInputSchema
} from '../forwardTargets.js';
export type { TargetInput } from '../forwardTargets.js';

/** A `users` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type UserRow = Selectable<DB['users']>;

export type FindMeLeg = { number: string; delayS: number };
/** Shared by `users.create` and `users.update`: each leg dials out (§10.1), so its number is E.164. */
export const findMeSchema = z
  .array(
    z.object({
      number: z
        .string()
        .refine(isE164, 'number must be E.164')
        .describe('The external number this leg rings, E.164.'),
      delayS: z
        .number()
        .int()
        .min(0)
        .describe(
          'Seconds after ringing begins before this leg starts; 0 rings with the devices.'
        )
    })
  )
  .describe(
    "External numbers rung alongside the user's devices on direct calls, never through a ring group; the answerer presses 1 to accept; self-service."
  );

/** The user extension's meaning (§11.2 `users`), required on create and optional on update. */
export const EXTENSION_DESCRIPTION =
  "The internal number colleagues dial, digits of the tenant's fixed extension length.";

/** The call-handling fields `users.create` and `users.update` share, each optional (§11.2 `users`). */
export const userCallFields = {
  ringTimeoutS: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Seconds the user's devices ring before the noAnswer rule applies; 25 by default; self-service."
    ),
  clir: z
    .boolean()
    .nullish()
    .describe(
      'Withholds the number on outbound calls; null inherits from the trunk, then settings.clir; self-service.'
    ),
  rejectAnonymous: z
    .boolean()
    .nullish()
    .describe(
      'Refuses callers who withhold their number; null follows settings.rejectAnonymous; self-service.'
    ),
  recordCalls: z
    .boolean()
    .optional()
    .describe(
      "Records this user's calls; admin-set (see zamfono.help recording-consent)."
    ),
  notifyMissedCalls: z
    .boolean()
    .optional()
    .describe(
      'Sends an e-mail per missed inbound call; on by default; self-service.'
    ),
  mailboxEnabled: z
    .boolean()
    .optional()
    .describe(
      'Gives the user a voicemail box, where an absent forward rule sends the call; on by default.'
    )
};

export type UserOut = LogLevelColumns & {
  id: string;
  name: string;
  email: string;
  role: Role;
  extension: string;
  ringTimeoutS: number;
  dnd: boolean;
  findMe: FindMeLeg[];
  calleridDidId: string | null;
  clir: boolean | null;
  rejectAnonymous: boolean | null;
  recordCalls: boolean;
  notifyMissedCalls: boolean;
  mailboxEnabled: boolean;
  mailboxAudioId: string | null;
  /** The ISO instant an active §5.5 login lock on this account expires at, `null` while unlocked. */
  lockedUntil: string | null;
  createdAt: string;
};

/** Assembles the wire shape of a user from its row and extension (§10.3); never the password hash. */
export async function toUserOut(
  db: Transaction<DB>,
  row: UserRow
): Promise<UserOut> {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    extension: await userExtension(db, row.id),
    ringTimeoutS: row.ringTimeoutS,
    dnd: row.dnd === 1,
    findMe: row.findMeJson
      ? findMeSchema.parse(JSON.parse(row.findMeJson))
      : [],
    calleridDidId: row.calleridDidId,
    clir: row.clir === null ? null : row.clir === 1,
    rejectAnonymous:
      row.rejectAnonymous === null ? null : row.rejectAnonymous === 1,
    recordCalls: row.recordCalls === 1,
    notifyMissedCalls: row.notifyMissedCalls === 1,
    mailboxEnabled: row.mailboxEnabled === 1,
    mailboxAudioId: row.mailboxAudioId,
    ...logLevelWire(row),
    lockedUntil: accountLockedUntil(row.email),
    createdAt: row.createdAt
  };
}

/**
 * Throws `OpError(409)` when `user` is the tenant's last live owner: owners are never demoted or
 * soft-deleted below one (§5.3, §5.9, §10.3).
 */
export async function assertNotLastOwner(
  db: Transaction<DB>,
  user: Pick<UserRow, 'id' | 'role'>
): Promise<void> {
  if (user.role !== 'owner') {
    return;
  }
  const owners = await db
    .selectFrom('users')
    .select('id')
    .where('role', '=', 'owner')
    .where('deletedAt', 'is', null)
    .execute();
  if (owners.length <= 1) {
    throw new OpError(HTTP_CONFLICT, "cannot remove the tenant's last owner");
  }
}

/** Throws `OpError(422)` for a `calleridDidId` that is not a live, numeric DID (§9.4 "Caller-ID"). */
export async function assertCallerIdDidValid(
  db: Transaction<DB>,
  id: string
): Promise<void> {
  const did = await db
    .selectFrom('dids')
    .select(['id', 'number'])
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!did) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `unknown or deleted DID: ${id}`
    );
  }
  if (!isE164(did.number)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `calleridDidId must be a numeric DID: ${id}`
    );
  }
}

/** Throws `OpError(409)` when `email` is already used by another live user (`users_email` UNIQUE). */
export async function assertEmailAvailable(
  db: Transaction<DB>,
  email: string,
  excludeId?: string
): Promise<void> {
  await assertNoLiveHolder(
    db,
    'users: e-mail already in use',
    { table: 'users', kind: 'user', label: 'email', values: { email } },
    excludeId
  );
}

/** Loads a live user by id, or throws `OpError(404)`. */
export async function liveUser(
  db: Transaction<DB>,
  id: string
): Promise<UserRow> {
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(HTTP_NOT_FOUND, `user '${id}' not found`);
  }
  return row;
}
