import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { memberSchema } from '../members.js';
import { pushRoster } from '../roster.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import { replaceMembers } from './_members.js';
import {
  assertGroupAudioFieldsAvailable,
  assertNameAvailable,
  nextExtension,
  optionalFlag,
  RING_GROUP_FIELD_DESCRIPTIONS,
  toRingGroupOut,
  type RingGroupOut
} from './_shared.js';

export const ringGroupInputSchema = z
  .object({
    name: z.string().min(1),
    strategy: z
      .enum(['simultaneous', 'sequential', 'random'])
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.strategy),
    ringTimeoutS: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.ringTimeoutS),
    ringTotalS: z
      .number()
      .int()
      .positive()
      .nullish()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.ringTotalS),
    skipBusy: z
      .boolean()
      .optional()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.skipBusy),
    allowReject: z
      .boolean()
      .optional()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.allowReject),
    greetingAudioId: z
      .string()
      .nullish()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.greetingAudioId),
    mohAudioId: z
      .string()
      .nullish()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.mohAudioId),
    recordCalls: z
      .boolean()
      .optional()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.recordCalls),
    mailboxEnabled: z
      .boolean()
      .optional()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.mailboxEnabled),
    mailboxAudioId: z
      .string()
      .nullish()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.mailboxAudioId),
    members: z
      .array(memberSchema)
      .optional()
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.members)
  })
  .strict();

export const createRingGroup = defineOperation({
  name: 'ringGroups.create',
  description: 'Creates a ring group and assigns it a tenant extension.',
  input: ringGroupInputSchema,
  minRole: 'admin',
  entity: (_input, out: RingGroupOut) => ({ kind: 'ringGroup', id: out.id }),
  run: async (ctx, input) => {
    await assertNameAvailable(ctx.db, input.name);
    await assertGroupAudioFieldsAvailable(ctx.db, input);
    const id = newId();
    const ext = await nextExtension(ctx.db);
    await ctx.db
      .insertInto('ringGroups')
      .values({
        id,
        name: input.name,
        strategy: input.strategy,
        ringTimeoutS: input.ringTimeoutS,
        ringTotalS: input.ringTotalS ?? null,
        skipBusy: optionalFlag(input.skipBusy),
        allowReject: optionalFlag(input.allowReject),
        greetingAudioId: input.greetingAudioId ?? null,
        mohAudioId: input.mohAudioId ?? null,
        recordCalls: optionalFlag(input.recordCalls),
        mailboxEnabled: optionalFlag(input.mailboxEnabled),
        mailboxAudioId: input.mailboxAudioId ?? null,
        createdAt: ctx.now
      })
      .execute();
    await ctx.db
      .insertInto('extensions')
      .values({ ext, ringGroupId: id })
      .execute();
    if (input.members) {
      await replaceMembers(ctx.db, id, input.members);
    }
    recordChange(ctx, { field: 'name', from: null, to: input.name });
    recordChange(ctx, { field: 'ext', from: null, to: ext });
    propagate(ctx, ['pjsip', 'dialplan']);
    await pushRoster(ctx);
    const row = await ctx.db
      .selectFrom('ringGroups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toRingGroupOut(ctx.db, row);
  }
});
