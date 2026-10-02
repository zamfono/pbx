import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { memberSchema } from '../members.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  assertNameAvailable,
  replaceMembers,
  toUserGroupOut,
  type UserGroupOut
} from './_shared.js';

export const userGroupInputSchema = z
  .object({
    name: z.string().min(1),
    members: z
      .array(memberSchema)
      .optional()
      .describe(
        'Users and nested user groups in the group; replaces the list as a whole.'
      )
  })
  .strict();

export const createUserGroup = defineOperation({
  name: 'userGroups.create',
  description:
    'Creates a user group, a nestable set of users for ring-group membership and outbound-route caller lists.',
  input: userGroupInputSchema,
  minRole: 'admin',
  entity: (_input, out: UserGroupOut) => ({ kind: 'userGroup', id: out.id }),
  run: async (ctx, input) => {
    await assertNameAvailable(ctx.db, input.name);
    const id = newId();
    await ctx.db
      .insertInto('userGroups')
      .values({ id, name: input.name, createdAt: ctx.now })
      .execute();
    if (input.members) {
      await replaceMembers(ctx.db, id, input.members);
      // Recorded in `userGroupInputSchema`'s `members` shape, which `userGroups.create` accepts,
      // so an undo replays `from` through this operation (§5.8).
      recordChange(ctx, { field: 'members', from: [], to: input.members });
      propagate(ctx, ['pjsip']);
    }
    recordChange(ctx, { field: 'name', from: null, to: input.name });
    const row = await ctx.db
      .selectFrom('userGroups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toUserGroupOut(ctx.db, row);
  }
});
