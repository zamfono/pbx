import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { pushRoster } from '../roster.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import { memberSchema, replaceMembers } from './_members.js';
import {
  assertGroupAudioFieldsAvailable,
  assertNameAvailable,
  nextExtension,
  optionalFlag,
  toRingGroupOut,
  type RingGroupOut
} from './_shared.js';

export const ringGroupInputSchema = z
  .object({
    name: z.string().min(1),
    strategy: z.enum(['simultaneous', 'sequential', 'random']),
    ringTimeoutS: z.number().int().positive().optional(),
    ringTotalS: z.number().int().positive().nullish(),
    skipBusy: z.boolean().optional(),
    allowReject: z.boolean().optional(),
    greetingAudioId: z.string().nullish(),
    mohAudioId: z.string().nullish(),
    recordCalls: z.boolean().optional(),
    mailboxEnabled: z.boolean().optional(),
    mailboxAudioId: z.string().nullish(),
    members: z.array(memberSchema).optional()
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
