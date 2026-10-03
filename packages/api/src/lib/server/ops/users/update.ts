import { z } from 'zod';

import { HTTP_FORBIDDEN, HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { assertAudioAvailable } from '../audio/_shared.js';
import { pushRoster } from '../roster.js';
import { propagate } from '../runner.js';
import {
  logLevelInputFields,
  recordLogLevelChanges,
  resolveLogLevel
} from '../settings/logLevel.js';
import { defineOperation, OpError, type Context } from '../types.js';
import { recordFieldChanges } from './_fieldChanges.js';
import { maybeRenameExtension, type AffectedDevice } from './_rename.js';
import {
  assertCallerIdDidValid,
  assertEmailAvailable,
  assertNotLastOwner,
  EXTENSION_DESCRIPTION,
  findMeSchema,
  liveUser,
  toUserOut,
  userCallFields,
  type UserOut,
  type UserRow
} from './_shared.js';

/** §10.3 "Users": the self-service subset a `user` actor may `PATCH` on their own profile. */
const SELF_SERVICE_FIELDS = new Set([
  'clir',
  'rejectAnonymous',
  'ringTimeoutS',
  'notifyMissedCalls',
  'findMe'
]);

const inputSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1).optional(),
    email: z.email().optional(),
    role: z
      .enum(['owner', 'admin', 'user'])
      .optional()
      .describe(
        'owner and admin configure the stack (only an owner writes owner-only settings), user only their own self-service fields; the last owner cannot be demoted.'
      ),
    extension: z.string().min(1).optional().describe(EXTENSION_DESCRIPTION),
    ...userCallFields,
    mailboxAudioId: z
      .string()
      .nullable()
      .optional()
      .describe('The personal voicemail greeting, an audio asset id.'),
    calleridDidId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The DID presented on the user's outbound calls; null presents the main number, settings.mainDidId (see zamfono.help numbers)."
      ),
    findMe: findMeSchema.optional(),
    ...logLevelInputFields
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
type Output = { user: UserOut; affectedDevices?: AffectedDevice[] };

/** Throws 403 unless `ctx.actor` may write every field `input` carries (§5.3, §10.3). */
function assertAllowedFields(ctx: Context, input: Input): void {
  if (ctx.actor.role !== 'user') {
    return;
  }
  if (ctx.actor.id !== input.id) {
    throw new OpError(
      HTTP_FORBIDDEN,
      'users: may update only your own profile'
    );
  }
  for (const key of Object.keys(input)) {
    if (key !== 'id' && !SELF_SERVICE_FIELDS.has(key)) {
      throw new OpError(HTTP_FORBIDDEN, `users: '${key}' is admin-only`);
    }
  }
}

/** Throws unless `ctx.actor` may set `input.role` on `before` (§5.3 "only owners change roles"). */
async function assertRoleChangeAllowed(
  ctx: Context,
  before: UserRow,
  input: Input
): Promise<void> {
  if (input.role === undefined || input.role === before.role) {
    return;
  }
  if (ctx.actor.role !== 'owner') {
    throw new OpError(HTTP_FORBIDDEN, 'users: only owners change roles');
  }
  if (input.role === 'owner' && before.passwordHash === null) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'users: an SSO-only user needs a password before becoming owner'
    );
  }
  if (before.role === 'owner') {
    await assertNotLastOwner(ctx.db, before);
  }
}

/** A nullable wire boolean's next column value: unchanged while absent, else `null` or 0/1. */
function nextNullableFlag(
  input: boolean | null | undefined,
  before: number | null
): number | null {
  if (input === undefined) {
    return before;
  }
  return input === null ? null : Number(input);
}

/** `input`'s scalar column values, `before`'s own where `input` omits the field. */
function resolvedFields(
  before: UserRow,
  input: Input
): Record<string, unknown> {
  return {
    name: input.name ?? before.name,
    email: input.email ?? before.email,
    role: input.role ?? before.role,
    ringTimeoutS: input.ringTimeoutS ?? before.ringTimeoutS,
    clir: nextNullableFlag(input.clir, before.clir),
    rejectAnonymous: nextNullableFlag(
      input.rejectAnonymous,
      before.rejectAnonymous
    ),
    recordCalls:
      input.recordCalls === undefined
        ? before.recordCalls
        : Number(input.recordCalls),
    notifyMissedCalls:
      input.notifyMissedCalls === undefined
        ? before.notifyMissedCalls
        : Number(input.notifyMissedCalls),
    mailboxEnabled:
      input.mailboxEnabled === undefined
        ? before.mailboxEnabled
        : Number(input.mailboxEnabled),
    mailboxAudioId:
      input.mailboxAudioId === undefined
        ? before.mailboxAudioId
        : input.mailboxAudioId,
    calleridDidId:
      input.calleridDidId === undefined
        ? before.calleridDidId
        : input.calleridDidId,
    findMeJson:
      input.findMe === undefined
        ? before.findMeJson
        : JSON.stringify(input.findMe)
  };
}

/**
 * §10.4 `onRosterChanged`: the branch-wide BLF roster carries every extension with its owner's
 * display name, so an extension rename and a rename of the person both move it. `after` is the
 * stored row, read once the UPDATE has landed, which is what the roster renders from.
 */
async function maybePushRoster(
  ctx: Context,
  before: UserRow,
  after: UserRow,
  extensionRenamed: boolean
): Promise<void> {
  if (!extensionRenamed && after.name === before.name) {
    return;
  }
  await pushRoster(ctx, [after]);
}

export const update = defineOperation({
  name: 'users.update',
  description:
    "Updates a user's profile; admins write every field, a user only their self-service subset.",
  input: inputSchema,
  minRole: 'user',
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    assertAllowedFields(ctx, input);
    const before = await liveUser(ctx.db, input.id);
    await assertRoleChangeAllowed(ctx, before, input);
    if (input.email !== undefined && input.email !== before.email) {
      await assertEmailAvailable(ctx.db, input.email, input.id);
    }
    if (input.calleridDidId !== undefined && input.calleridDidId !== null) {
      await assertCallerIdDidValid(ctx.db, input.calleridDidId);
    }
    if (input.mailboxAudioId !== undefined && input.mailboxAudioId !== null) {
      await assertAudioAvailable(ctx.db, input.mailboxAudioId);
    }

    const affectedDevices = await maybeRenameExtension(ctx, input);
    const after = resolvedFields(before, input);
    const logLevel = resolveLogLevel(ctx, before, input);
    recordFieldChanges(ctx, before, after);
    if (logLevel) {
      recordLogLevelChanges(ctx, before, logLevel);
    }
    await ctx.db
      .updateTable('users')
      .set({ ...after, ...logLevel })
      .where('id', '=', input.id)
      .execute();

    const row = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    await maybePushRoster(ctx, before, row, affectedDevices !== undefined);
    const output: Output = { user: await toUserOut(ctx.db, row) };
    if (affectedDevices !== undefined) {
      output.affectedDevices = affectedDevices;
    }
    // The routing pipeline reads this row — the ring timeout, find-me legs, CLIR and
    // reject-anonymous among them — so every update reaches `core`, not only the extension
    // rename `maybeRenameExtension` already propagates for. The name is the caller-ID name on
    // every endpoint of the user's (`pjsip/render.ts`), so renaming the person re-renders them.
    propagate(ctx, row.name === before.name ? [] : ['pjsip']);
    return output;
  }
});
