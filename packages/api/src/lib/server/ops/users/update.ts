import { z } from 'zod';

import {
  findMeSchema,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  USER_ROLES
} from '@zamfono/shared';

import { revokeUserPersonalAccessTokens } from '#lib/server/auth/personalAccessTokens.js';
import { revokeUserTokens } from '#lib/server/auth/tokens.js';

import { assertAudioOfKind } from '../audio/_shared.js';
import { recordChange, recordFieldChanges } from '../audit.js';
import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { logLevelInputFields, resolveLogLevel } from '../settings/logLevel.js';
import { defineOperation, type Context } from '../types.js';
import { affectedDevice, maybeRenameExtension } from './_rename.js';
import { issueSetPasswordLink } from './_setupMail.js';
import {
  assertCallerIdDidValid,
  assertEmailAvailable,
  assertFindMeNotOwnDid,
  EXTENSION_DESCRIPTION,
  liveUser,
  toUserOut,
  userCallFields,
  userOut,
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
      .enum(USER_ROLES)
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
    callerIdDidId: z
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
const outputSchema = z.object({
  user: userOut,
  affectedDevices: z
    .array(affectedDevice)
    .optional()
    .describe(
      "The user's devices an extension change renamed, each with its new SIP username."
    ),
  setupLink: z
    .string()
    .optional()
    .describe(
      'Promoting a user without a password to owner: the one-time link they set one with, also mailed to them; they cannot log in until then.'
    )
});
type Output = z.infer<typeof outputSchema>;

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
    mailboxMaxMessages:
      input.mailboxMaxMessages === undefined
        ? before.mailboxMaxMessages
        : input.mailboxMaxMessages,
    callerIdDidId:
      input.callerIdDidId === undefined
        ? before.callerIdDidId
        : input.callerIdDidId,
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

/**
 * Promoting a user without a password, an SSO-only one, to owner (§5.2): an owner logs in only
 * once they have one, so their sessions and personal access tokens end with the promotion, and
 * the set-password link they set it through is issued and mailed. `undefined` for any other change.
 */
async function promoteWithoutPassword(
  ctx: Context,
  before: UserRow,
  input: Input
): Promise<string | undefined> {
  if (
    input.role !== 'owner' ||
    before.role === 'owner' ||
    before.passwordHash !== null
  ) {
    return undefined;
  }
  await revokeUserTokens(ctx.db, before.id, ctx.now);
  await revokeUserPersonalAccessTokens(ctx.db, before.id, ctx.now);
  recordChange(ctx, { field: 'tokensRevoked', from: false, to: true });
  return issueSetPasswordLink(ctx, before.id);
}

export const update = defineOperation({
  name: 'users.update',
  description:
    "Updates a user's profile; admins write every field, a user only their self-service subset.",
  input: inputSchema,
  output: outputSchema,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
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
    if (input.callerIdDidId !== undefined && input.callerIdDidId !== null) {
      await assertCallerIdDidValid(ctx.db, input.callerIdDidId);
    }
    if (input.findMe !== undefined) {
      await assertFindMeNotOwnDid(ctx.db, input.findMe);
    }
    if (input.mailboxAudioId !== undefined && input.mailboxAudioId !== null) {
      await assertAudioOfKind(ctx.db, input.mailboxAudioId, 'vmGreeting');
    }

    const affectedDevices = await maybeRenameExtension(ctx, input);
    const setupLink = await promoteWithoutPassword(ctx, before, input);
    const after = resolvedFields(before, input);
    const logLevel = resolveLogLevel(ctx, before, input);
    recordFieldChanges(
      ctx,
      before,
      { ...after, ...logLevel },
      USER_WIRE_COLUMNS
    );
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
    if (setupLink !== undefined) {
      output.setupLink = setupLink;
    }
    // The routing pipeline reads this row — the ring timeout, find-me legs, CLIR and
    // reject-anonymous among them — so every update reaches `core`, not only the extension
    // rename `maybeRenameExtension` already propagates for. The name is the caller-ID name on
    // every endpoint of the user's (`pjsip/render.ts`), so renaming the person re-renders them.
    propagate(ctx, row.name === before.name ? [] : ['pjsip']);
    return output;
  }
});
