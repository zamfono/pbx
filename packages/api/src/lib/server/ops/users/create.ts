import { z } from 'zod';

import {
  findMeSchema,
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE_CONTENT,
  newId,
  USER_ROLES
} from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { defineOperation, type Context } from '../types.js';
import { assertContact } from './_contact.js';
import {
  assertExtensionAvailable,
  assertValidExtension
} from './_extensions.js';
import { issueSetPasswordLink } from './_setupMail.js';
import {
  assertEmailAvailable,
  assertFindMeNotOwnDid,
  EMAIL_DESCRIPTION,
  EXTENSION_DESCRIPTION,
  toUserOut,
  userCallFields,
  userOut
} from './_shared.js';

const inputSchema = z
  .object({
    name: z.string().min(1),
    email: z.email().nullish().describe(EMAIL_DESCRIPTION),
    role: z
      .enum(USER_ROLES)
      .optional()
      .describe(
        "owner and admin, given by an owner only, configure the stack, user only their own self-service fields; 'user' by default. A new owner cannot log in until they set their password through the setup link."
      ),
    extension: z.string().min(1).nullish().describe(EXTENSION_DESCRIPTION),
    ...userCallFields,
    findMe: findMeSchema.optional()
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
const outputSchema = z.object({
  user: userOut,
  setupLink: z
    .string()
    .nullable()
    .describe(
      'The one-time link the user sets their password with, also mailed to them; null for a user without an e-mail, who cannot log in.'
    )
});
type Output = z.infer<typeof outputSchema>;

async function insertUserRow(
  ctx: Context,
  id: string,
  input: Input
): Promise<void> {
  await ctx.db
    .insertInto('users')
    .values({
      id,
      name: input.name,
      email: input.email ?? null,
      role: input.role ?? 'user',
      ringTimeoutS: input.ringTimeoutS,
      findMeJson: input.findMe ? JSON.stringify(input.findMe) : null,
      clir:
        input.clir === undefined || input.clir === null
          ? null
          : Number(input.clir),
      rejectAnonymous:
        input.rejectAnonymous === undefined || input.rejectAnonymous === null
          ? null
          : Number(input.rejectAnonymous),
      recordCalls:
        input.recordCalls === undefined ? undefined : Number(input.recordCalls),
      notifyMissedCalls:
        input.notifyMissedCalls === undefined
          ? undefined
          : Number(input.notifyMissedCalls),
      mailboxEnabled:
        input.mailboxEnabled === undefined
          ? undefined
          : Number(input.mailboxEnabled),
      mailboxMaxMessages: input.mailboxMaxMessages,
      createdAt: ctx.now
    })
    .execute();
}

/** Refuses `input` a new user may not have (§11.2): no e-mail and no extension, an owner or admin
 *  without an e-mail (422); an invalid extension, an own DID among the find-me legs (422); an
 *  extension or e-mail already taken (409). */
async function assertCreatable(ctx: Context, input: Input): Promise<void> {
  const email = input.email ?? null;
  const extension = input.extension ?? null;
  assertContact(
    { role: input.role ?? 'user', email, extension },
    HTTP_UNPROCESSABLE_CONTENT
  );
  if (extension !== null) {
    await assertValidExtension(ctx.db, extension);
    await assertExtensionAvailable(ctx.db, extension);
  }
  if (email !== null) {
    await assertEmailAvailable(ctx.db, email);
  }
  await assertFindMeNotOwnDid(ctx.db, input.findMe ?? []);
}

/** `POST /users` (§10.3 "Users"): creates a user, their extension if they have one, and a
 *  one-time setup link if they have an e-mail. */
export const create = defineOperation({
  name: 'users.create',
  description:
    'Creates a user, with an e-mail, an extension or both, and returns a setup link for one with an e-mail.',
  input: inputSchema,
  output: outputSchema,
  problems: [HTTP_CONFLICT],
  minRole: 'admin',
  // Only an owner brings an admin or an owner into being (§10.3).
  ownerOnly: (_ctx, input) => input.role !== undefined && input.role !== 'user',
  entity: (_input, out: Output) => ({ kind: 'user', id: out.user.id }),
  run: async (ctx, input) => {
    await assertCreatable(ctx, input);
    const id = newId();
    await insertUserRow(ctx, id, input);
    if (input.extension) {
      await ctx.db
        .insertInto('extensions')
        .values({ ext: input.extension, userId: id })
        .execute();
    }
    // A user without an e-mail cannot log in (§5.2), so has no password to set.
    const setupLink = input.email
      ? await issueSetPasswordLink(ctx, id, 'setup')
      : null;

    recordChange(ctx, { field: 'name', from: null, to: input.name });
    recordChange(ctx, { field: 'email', from: null, to: input.email ?? null });
    recordChange(ctx, {
      field: 'extension',
      from: null,
      to: input.extension ?? null
    });
    propagate(ctx, ['pjsip', 'dialplan']);

    // The new extension joins the roster (§10.4); the user has no device to push yet.
    await pushRoster(ctx);

    const row = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { user: await toUserOut(ctx.db, row), setupLink };
  }
});
