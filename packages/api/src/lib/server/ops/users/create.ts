import * as env from '$app/env/private';
import pino from 'pino';
import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { issueResetToken } from '#lib/server/auth/tokens.js';
import { sendMail } from '#lib/server/mail/index.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { pushRoster } from '../roster.js';
import { afterPropagation, propagate, recordChange } from '../runner.js';
import { defineOperation, type Context } from '../types.js';
import {
  assertExtensionAvailable,
  assertValidExtension
} from './_extensions.js';
import { setupLinkFor } from './_setupMail.js';
import {
  assertEmailAvailable,
  EXTENSION_DESCRIPTION,
  findMeSchema,
  toUserOut,
  userCallFields,
  type UserOut
} from './_shared.js';

const logger = pino({ name: 'users.create' });

// §11.2 `users` CHECK (role <> 'owner' OR password_hash IS NOT NULL): this operation never sets
// a password, so it never creates an owner; promotion to owner happens through `users.update`.
const CREATABLE_ROLES = ['admin', 'user'] as const;

const inputSchema = z
  .object({
    name: z.string().min(1),
    email: z.email(),
    role: z
      .enum(CREATABLE_ROLES)
      .optional()
      .describe(
        "admin configures the stack, user only their own self-service fields; 'user' by default, owner only by promotion through users.update."
      ),
    extension: z.string().min(1).describe(EXTENSION_DESCRIPTION),
    ...userCallFields,
    findMe: findMeSchema.optional()
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
type Output = { user: UserOut; setupLink: string };

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
      email: input.email,
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
      createdAt: ctx.now
    })
    .execute();
}

/** `POST /users` (§10.3 "Users"): creates a user, their extension and a one-time setup link. */
export const create = defineOperation({
  name: 'users.create',
  description:
    'Creates a user, assigns their extension and returns a setup link.',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, out: Output) => ({ kind: 'user', id: out.user.id }),
  run: async (ctx, input) => {
    await assertValidExtension(ctx.db, input.extension);
    await assertExtensionAvailable(ctx.db, input.extension);
    await assertEmailAvailable(ctx.db, input.email);

    const id = newId();
    await insertUserRow(ctx, id, input);
    await ctx.db
      .insertInto('extensions')
      .values({ ext: input.extension, userId: id })
      .execute();

    const { raw, expiresAt } = await issueResetToken(
      ctx.db,
      id,
      'setup',
      ctx.now
    );
    const setupLink = setupLinkFor(raw);
    // Started once the write has committed, never after a rollback, and not awaited:
    // `sendMail`'s in-process retries (§10.2 "Failure") run over several minutes.
    afterPropagation(ctx, db => {
      sendMail(db, keyringFromEnv(env), {
        kind: 'setup',
        to: { userId: id },
        values: {
          link: setupLink,
          linkExpiresAt: expiresAt,
          invitedBy: ctx.actor.name
        }
      }).catch((error: unknown) => {
        logger.warn({ err: error }, 'users.create: setup mail failed');
      });
      return Promise.resolve(null);
    });

    recordChange(ctx, { field: 'name', from: null, to: input.name });
    recordChange(ctx, { field: 'email', from: null, to: input.email });
    recordChange(ctx, { field: 'extension', from: null, to: input.extension });
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
