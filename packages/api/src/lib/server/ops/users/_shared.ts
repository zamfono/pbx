import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import {
  findMeColumn,
  findMeSchema,
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE_CONTENT,
  isE164,
  USER_ROLES,
  type DB
} from '@zamfono/shared';

import { assertNoLiveHolder } from '../liveHolder.js';
import { liveRow } from '../rows.js';
import { logLevelOutputFields, logLevelWire } from '../settings/logLevel.js';
import { OpError, type Context } from '../types.js';
import { accountLockedUntil } from './_accountLock.js';
import { userExtension } from './_extensions.js';

/** A `users` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type UserRow = Selectable<DB['users']>;

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

/** A user's wire shape (§10.3), as `toUserOut` assembles it: never the password hash. */
export const userOut = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  extension: z.string(),
  ringTimeoutS: z.number(),
  dnd: z.boolean(),
  findMe: findMeSchema,
  callerIdDidId: z.string().nullable(),
  clir: z.boolean().nullable(),
  rejectAnonymous: z.boolean().nullable(),
  recordCalls: z.boolean(),
  notifyMissedCalls: z.boolean(),
  mailboxEnabled: z.boolean(),
  mailboxAudioId: z.string().nullable(),
  ...logLevelOutputFields,
  lockedUntil: z
    .string()
    .nullable()
    .describe(
      'When an active login lock on this account (§5.5) expires, ISO 8601; null while unlocked.'
    ),
  createdAt: z.string()
});
export type UserOut = z.infer<typeof userOut>;

/** Assembles the wire shape of a user from its row and extension (§10.3); never the password hash. */
export async function toUserOut(
  db: Transaction<DB>,
  row: UserRow
): Promise<UserOut> {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    extension: await userExtension(db, row.id),
    ringTimeoutS: row.ringTimeoutS,
    dnd: row.dnd === 1,
    findMe: findMeColumn.decode(row.findMeJson),
    callerIdDidId: row.callerIdDidId,
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

/** Throws `OpError(422)` for a `callerIdDidId` that is not a live, numeric DID (§9.4 "Caller-ID"). */
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
      `callerIdDidId must be a numeric DID: ${id}`
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
  return liveRow(db, 'users', id, `user '${id}' not found`);
}

/** The `ownerOnly` of an operation addressing a live user by `id`: an owner's account is
 *  owner-only (§10.3). Throws `OpError(404)` when no live user has that id. */
export async function namesAnOwner(
  ctx: Context,
  input: { id: string }
): Promise<boolean> {
  return (await liveUser(ctx.db, input.id)).role === 'owner';
}
