import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import { pushRoster } from '../roster.js';
import { propagate, recordChange } from '../runner.js';
import {
  logLevelInputFields,
  recordLogLevelChanges,
  resolveLogLevel
} from '../settings/logLevel.js';
import { defineOperation, OpError, type Context } from '../types.js';
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
  toRingGroupOut,
  type RingGroupRow
} from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const updateRingGroupInput = z
  .object({
    id: z.string(),
    name: z.string().min(1).optional(),
    strategy: z.enum(['simultaneous', 'sequential', 'random']).optional(),
    ringTimeoutS: z.number().int().positive().optional(),
    ringTotalS: z.number().int().positive().nullish(),
    skipBusy: z.boolean().optional(),
    allowReject: z.boolean().optional(),
    greetingAudioId: z.string().nullish(),
    mohAudioId: z.string().nullish(),
    recordCalls: z.boolean().optional(),
    mailboxEnabled: z.boolean().optional(),
    mailboxAudioId: z.string().nullish(),
    members: z.array(memberSchema).optional(),
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

/** Records one `audit_log` diff entry per field whose resolved value differs from `before`'s. */
function recordFieldChanges(
  ctx: Context,
  before: RingGroupRow,
  after: ReturnType<typeof resolvedFields>
): void {
  for (const field of Object.keys(after) as (keyof typeof after)[]) {
    if (after[field] !== before[field]) {
      recordChange(ctx, { field, from: before[field], to: after[field] });
    }
  }
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
