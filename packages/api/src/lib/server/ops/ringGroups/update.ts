import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND } from '@zamfono/shared';

import { recordChange, recordFieldChanges } from '../audit.js';
import type { MemberSpec } from '../members.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { logLevelInputFields, resolveLogLevel } from '../settings/logLevel.js';
import { defineOperation } from '../types.js';
import { ringGroupFields } from './_input.js';
import { replaceMembers, ringGroupMembers } from './_members.js';
import {
  assertGroupAudioFieldsAvailable,
  assertNameAvailable,
  liveRingGroup,
  optionalFlag,
  ringGroupOut,
  toRingGroupOut,
  type RingGroupRow
} from './_shared.js';

export const updateRingGroupInput = z
  .object({
    id: z.string(),
    ...z.object(ringGroupFields).partial().shape,
    ...logLevelInputFields
  })
  .strict();

/** The row's next scalar values: `input`'s value where given, `before`'s own otherwise. */
function resolvedFields(
  before: RingGroupRow,
  input: z.infer<typeof updateRingGroupInput>
): Omit<
  RingGroupRow,
  'id' | 'createdAt' | 'deletedAt' | 'logLevel' | 'logLevelExpiresAt'
> {
  return {
    name: input.name ?? before.name,
    strategy: input.strategy ?? before.strategy,
    ringTimeoutS: input.ringTimeoutS ?? before.ringTimeoutS,
    ringTotalS:
      input.ringTotalS === undefined ? before.ringTotalS : input.ringTotalS,
    skipBusy: optionalFlag(input.skipBusy) ?? before.skipBusy,
    allowReject: optionalFlag(input.allowReject) ?? before.allowReject,
    greetingAudioId:
      input.greetingAudioId === undefined
        ? before.greetingAudioId
        : input.greetingAudioId,
    mohAudioId:
      input.mohAudioId === undefined ? before.mohAudioId : input.mohAudioId,
    recordCalls: optionalFlag(input.recordCalls) ?? before.recordCalls,
    mailboxEnabled: optionalFlag(input.mailboxEnabled) ?? before.mailboxEnabled,
    mailboxAudioId:
      input.mailboxAudioId === undefined
        ? before.mailboxAudioId
        : input.mailboxAudioId
  };
}

export const updateRingGroup = defineOperation({
  name: 'ringGroups.update',
  description: "Updates a ring group's configuration.",
  input: updateRingGroupInput,
  output: ringGroupOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: input => ({ kind: 'ringGroup', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveRingGroup(ctx.db, input.id);
    if (input.name !== undefined && input.name !== before.name) {
      await assertNameAvailable(ctx.db, input.name, input.id);
    }
    await assertGroupAudioFieldsAvailable(ctx.db, input);
    const after = resolvedFields(before, input);
    const logLevel = resolveLogLevel(ctx, before, input);
    recordFieldChanges(ctx, before, { ...after, ...logLevel });
    await ctx.db
      .updateTable('ringGroups')
      .set({ ...after, ...logLevel })
      .where('id', '=', input.id)
      .execute();
    if (input.members) {
      const beforeMembers = await ringGroupMembers(ctx.db, input.id);
      await replaceMembers(ctx.db, input.id, input.members);
      // Recorded in `updateRingGroupInput`'s `members` shape, which `ringGroups.update` accepts,
      // so an undo replays `from` through this operation (§5.8).
      recordChange(ctx, {
        field: 'members',
        from: beforeMembers.map((member): MemberSpec => ({
          kind: member.kind,
          id: member.id
        })),
        to: input.members
      });
      propagate(ctx, ['pjsip']);
    }
    // Every field `core` routes on (strategy, timeouts, mailbox, the diagnostics override, §7)
    // reaches it only once its config cache drops, which an Asterisk reload is not needed for.
    propagate(ctx, []);
    // The group's name titles its extension's roster entry (§10.4 "Colleague presence").
    if (after.name !== before.name) {
      await pushRoster(ctx);
    }
    const row = await ctx.db
      .selectFrom('ringGroups')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    return toRingGroupOut(ctx.db, row);
  }
});
