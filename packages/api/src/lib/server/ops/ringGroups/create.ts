import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND, newId } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { defineOperation } from '../types.js';
import { ringGroupFields } from './_input.js';
import { replaceMembers } from './_members.js';
import {
  assertGroupAudioFieldsAvailable,
  assertNameAvailable,
  nextExtension,
  optionalFlag,
  ringGroupOut,
  toRingGroupOut,
  type RingGroupOut
} from './_shared.js';

export const ringGroupInputSchema = z.object(ringGroupFields).strict();

export const createRingGroup = defineOperation({
  name: 'ringGroups.create',
  description: 'Creates a ring group and assigns it a tenant extension.',
  input: ringGroupInputSchema,
  output: ringGroupOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
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
