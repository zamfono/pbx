import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import { pushRoster } from '../roster.js';
import { propagate, recordChange, recordFieldChanges } from '../runner.js';
import {
  logLevelInputFields,
  recordLogLevelChanges,
  resolveLogLevel
} from '../settings/logLevel.js';
import { defineOperation, OpError } from '../types.js';
import {
  memberSchema,
  replaceMembers,
  ringGroupMembers,
  type MemberSpec
} from './_members.js';
import {
  assertGroupAudioFieldsAvailable,
  assertNameAvailable,
  optionalFlag,
  RING_GROUP_FIELD_DESCRIPTIONS,
  toRingGroupOut,
  type RingGroupRow
} from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const updateRingGroupInput = z
  .object({
    id: z.string(),
    name: z.string().min(1).optional(),
    strategy: z
      .enum(['simultaneous', 'sequential', 'random'])
      .optional()
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
      .describe(RING_GROUP_FIELD_DESCRIPTIONS.members),
    ...logLevelInputFields
  })
  .strict();

async function fetchLive(
  db: Transaction<DB>,
  id: string
): Promise<RingGroupRow> {
  const row = await db
    .selectFrom('ringGroups')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(STATUS_NOT_FOUND, `ring group '${id}' not found`);
  }
  return row;
}

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
  minRole: 'admin',
  entity: input => ({ kind: 'ringGroup', id: input.id }),
  run: async (ctx, input) => {
    const before = await fetchLive(ctx.db, input.id);
    if (input.name !== undefined && input.name !== before.name) {
      await assertNameAvailable(ctx.db, input.name, input.id);
    }
    await assertGroupAudioFieldsAvailable(ctx.db, input);
    const after = resolvedFields(before, input);
    const logLevel = resolveLogLevel(ctx, before, input);
    recordFieldChanges(ctx, before, after);
    if (logLevel) {
      recordLogLevelChanges(ctx, before, logLevel);
    }
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
