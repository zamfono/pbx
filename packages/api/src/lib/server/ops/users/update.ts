import { z } from 'zod';

import { assertAudioOfKind } from '../audio/_shared.js';
import { recordFieldChanges } from '../audit.js';
import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import {
  logLevelInputFields,
  recordLogLevelChanges,
  resolveLogLevel
} from '../settings/logLevel.js';
import { defineOperation, type Context } from '../types.js';
import { maybeRenameExtension, type AffectedDevice } from './_rename.js';
import {
  assertCallerIdDidValid,
  assertEmailAvailable,
  EXTENSION_DESCRIPTION,
  findMeSchema,
  liveUser,
  toUserOut,
  userCallFields,
  type UserOut,
  type UserRow
} from './_shared.js';
import {
  assertAllowedFields,
  assertEmailChangeAllowed,
  assertRoleChangeAllowed
} from './_updateAccess.js';
import { USER_WIRE_COLUMNS } from './_wireColumns.js';

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
function resolvedFields(before: UserRow, input: Input): Partial<UserRow> {
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
 * display name, and the person's Ringotel user their name and e-mail, so an extension rename, a
 * rename of the person and a new e-mail address all move it. `after` is the stored row, read once
 * the UPDATE has landed, which is what the roster renders from.
 */
async function maybePushRoster(
  ctx: Context,
  before: UserRow,
  after: UserRow,
  extensionRenamed: boolean
): Promise<void> {
  if (
    !extensionRenamed &&
    after.name === before.name &&
    after.email === before.email
  ) {
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
  scope: ownUserId,
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    assertAllowedFields(ctx, input);
    const before = await liveUser(ctx.db, input.id);
    await assertRoleChangeAllowed(ctx, before, input);
    assertEmailChangeAllowed(ctx, before, input);
    if (input.email !== undefined && input.email !== before.email) {
      await assertEmailAvailable(ctx.db, input.email, input.id);
    }
    if (input.calleridDidId !== undefined && input.calleridDidId !== null) {
      await assertCallerIdDidValid(ctx.db, input.calleridDidId);
    }
    if (input.mailboxAudioId !== undefined && input.mailboxAudioId !== null) {
      await assertAudioOfKind(ctx.db, input.mailboxAudioId, 'vmGreeting');
    }

    const affectedDevices = await maybeRenameExtension(ctx, input);
    const after = resolvedFields(before, input);
    const logLevel = resolveLogLevel(ctx, before, input);
    recordFieldChanges(ctx, before, after, USER_WIRE_COLUMNS);
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
