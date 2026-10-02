import { z } from 'zod';

import { memberSchema } from '../members.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  assertNameAvailable,
  liveUserGroup,
  replaceMembers,
  toUserGroupOut,
  userGroupMembers
} from './_shared.js';

export const updateUserGroupInput = z
  .object({
    id: z.string(),
    name: z.string().min(1).optional(),
    members: z
      .array(memberSchema)
      .optional()
      .describe(
        'Users and nested user groups in the group; replaces the list as a whole.'
      )
  })
  .strict();

export const updateUserGroup = defineOperation({
  name: 'userGroups.update',
  description: "Updates a user group's name and nested membership.",
  input: updateUserGroupInput,
  minRole: 'admin',
  entity: input => ({ kind: 'userGroup', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveUserGroup(ctx.db, input.id);
    if (input.name !== undefined && input.name !== before.name) {
      await assertNameAvailable(ctx.db, input.name, input.id);
      recordChange(ctx, { field: 'name', from: before.name, to: input.name });
      await ctx.db
        .updateTable('userGroups')
        .set({ name: input.name })
        .where('id', '=', input.id)
        .execute();
    }
    if (input.members) {
      const beforeMembers = await userGroupMembers(ctx.db, input.id);
      await replaceMembers(ctx.db, input.id, input.members);
      // Recorded in `updateUserGroupInput`'s `members` shape, which `userGroups.update` accepts,
      // so an undo replays `from` through this operation (§5.8).
      recordChange(ctx, {
        field: 'members',
        from: beforeMembers,
        to: input.members
      });
      propagate(ctx, ['pjsip']);
    }
    const row = await ctx.db
      .selectFrom('userGroups')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    return toUserGroupOut(ctx.db, row);
  }
});
