import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND } from '@zamfono/shared';

import { assertAudioOfKind } from '../audio/_shared.js';
import { recordFieldChanges } from '../audit.js';
import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { resolveLogLevel } from '../settings/logLevel.js';
import { defineOperation, type Context } from '../types.js';
import { assertContact } from './_contact.js';
import {
  affectedDevice,
  planExtensionChange,
  withExtensionChange
} from './_extensionChange.js';
import { userExtension } from './_extensions.js';
import { dropLoginWithEmail, promoteWithoutPassword } from './_login.js';
import {
  assertCallerIdDidValid,
  assertEmailAvailable,
  assertFindMeNotOwnDid,
  liveUser,
  toUserOut,
  userOut,
  type UserRow
} from './_shared.js';
import {
  assertAllowedFields,
  assertEmailChangeAllowed,
  assertRoleChangeAllowed
} from './_updateAccess.js';
import {
  resolvedFields,
  updateInputSchema,
  type UpdateInput
} from './_updateInput.js';
import { USER_WIRE_COLUMNS } from './_wireColumns.js';

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

/**
 * §10.4 `onRosterChanged`: the branch-wide BLF roster carries every extension with its owner's
 * display name, and the person's Ringotel user their name and e-mail, so an extension change, a
 * rename of the person and a new e-mail address all move it. `after` is the stored row, read once
 * the UPDATE has landed, which is what the roster renders from.
 */
async function maybePushRoster(
  ctx: Context,
  before: UserRow,
  after: UserRow,
  extensionChanged: boolean
): Promise<void> {
  if (
    !extensionChanged &&
    after.name === before.name &&
    after.email === before.email
  ) {
    return;
  }
  await pushRoster(ctx, [after]);
}

/** Refuses what `input` asks beyond who may write it (`_updateAccess.ts`): a taken e-mail, an
 *  unknown caller-ID DID, an own DID among the find-me legs, an audio of the wrong kind. */
async function assertInputValid(
  ctx: Context,
  before: UserRow,
  input: UpdateInput
): Promise<void> {
  if (
    input.email !== undefined &&
    input.email !== null &&
    input.email !== before.email
  ) {
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
}

export const update = defineOperation({
  name: 'users.update',
  description:
    "Updates a user's profile; admins write every field, a user only their self-service subset.",
  input: updateInputSchema,
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
    await assertInputValid(ctx, before, input);

    const current = await userExtension(ctx.db, input.id);
    const extension = await planExtensionChange(
      ctx,
      input.id,
      current,
      input.extension
    );
    const after = resolvedFields(before, input);
    assertContact(
      {
        role: after.role,
        email: after.email,
        extension: extension ? extension.to : current
      },
      HTTP_CONFLICT
    );
    const setupLink = await promoteWithoutPassword(ctx, before, input.role);
    const logLevel = resolveLogLevel(ctx, before, input);
    const affectedDevices = await withExtensionChange(
      ctx,
      input.id,
      extension,
      async () => {
        recordFieldChanges(
          ctx,
          before,
          { ...after, ...logLevel },
          USER_WIRE_COLUMNS
        );
        const login = await dropLoginWithEmail(ctx, before, after.email);
        await ctx.db
          .updateTable('users')
          .set({ ...after, ...logLevel, ...login })
          .where('id', '=', input.id)
          .execute();
      }
    );

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
    // change `withExtensionChange` already propagates for. The name is the caller-ID name on
    // every endpoint of the user's (`pjsip/render.ts`), so renaming the person re-renders them.
    propagate(ctx, row.name === before.name ? [] : ['pjsip']);
    return output;
  }
});
