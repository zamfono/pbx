import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import { Conflict, OpError } from '../types.js';
import { assertNoCycle, loadEdgesExcludingParent } from './_nesting.js';

const STATUS_NOT_FOUND = 404;
const STATUS_UNPROCESSABLE_ENTITY = 422;

/** A `user_groups` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type UserGroupRow = Selectable<DB['userGroups']>;

/** Throws 409 when `name` is already used by another live user group (`user_groups_name` partial UNIQUE, §11.2). */
export async function assertNameAvailable(
  db: Transaction<DB>,
  name: string,
  excludeId?: string
): Promise<void> {
  let query = db
    .selectFrom('userGroups')
    .select(['id', 'name'])
    .where('name', '=', name)
    .where('deletedAt', 'is', null);
  if (excludeId !== undefined) {
    query = query.where('id', '!=', excludeId);
  }
  const existing = await query.executeTakeFirst();
  if (existing) {
    throw new Conflict('userGroups: name already in use', [
      { kind: 'userGroup', id: existing.id, label: existing.name }
    ]);
  }
}

export const memberSchema = z.object({
  kind: z.enum(['user', 'userGroup']),
  id: z.string()
});
export type MemberSpec = z.infer<typeof memberSchema>;

export type UserGroupMemberOut = { kind: 'user' | 'userGroup'; id: string };
export type UserGroupOut = {
  id: string;
  name: string;
  members: UserGroupMemberOut[];
};

/** Throws 422 when `members` lists the same user or user group twice (`user_group_users`/`user_group_groups`' PKs, §11.2). */
function assertMembersUnique(members: MemberSpec[]): void {
  const userIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const member of members) {
    const seen = member.kind === 'user' ? userIds : groupIds;
    if (seen.has(member.id)) {
      throw new OpError(
        STATUS_UNPROCESSABLE_ENTITY,
        `userGroups: duplicate ${member.kind} member '${member.id}'`
      );
    }
    seen.add(member.id);
  }
}

/** Throws 404 when a member names no live user or user-group row (`user_group_users`/`user_group_groups`' FKs, §11.2). */
async function assertMembersAvailable(
  db: Transaction<DB>,
  members: MemberSpec[]
): Promise<void> {
  await Promise.all(
    members.map(async member => {
      const table = member.kind === 'user' ? 'users' : 'userGroups';
      const row = await db
        .selectFrom(table)
        .select('id')
        .where('id', '=', member.id)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!row) {
        throw new OpError(
          STATUS_NOT_FOUND,
          `${member.kind} '${member.id}' not found`
        );
      }
    })
  );
}

/**
 * Replaces a user group's direct user members and nested child groups as a whole (§10.3 "User
 * groups"), cycle-checking every nested child first.
 */
export async function replaceMembers(
  db: Transaction<DB>,
  groupId: string,
  members: MemberSpec[]
): Promise<void> {
  assertMembersUnique(members);
  await assertMembersAvailable(db, members);
  const childGroupIds = members
    .filter(member => member.kind === 'userGroup')
    .map(member => member.id);
  if (childGroupIds.length > 0) {
    const edges = await loadEdgesExcludingParent(db, groupId);
    for (const childId of childGroupIds) {
      assertNoCycle(groupId, childId, edges);
    }
  }
  // `members` is the live list, the one a read returns: a link to a soft-deleted member stays, so
  // the membership survives the member's delete and undo round-trip (§5.9, §11.1 "the membership
  // tables"), and `members` cannot name that member again (`assertMembersAvailable`).
  await db
    .deleteFrom('userGroupUsers')
    .where('groupId', '=', groupId)
    .where('userId', 'not in', eb =>
      eb.selectFrom('users').select('id').where('deletedAt', 'is not', null)
    )
    .execute();
  await db
    .deleteFrom('userGroupGroups')
    .where('parentGroupId', '=', groupId)
    .where('childGroupId', 'not in', eb =>
      eb
        .selectFrom('userGroups')
        .select('id')
        .where('deletedAt', 'is not', null)
    )
    .execute();
  const userIds = members
    .filter(member => member.kind === 'user')
    .map(member => member.id);
  if (userIds.length > 0) {
    await db
      .insertInto('userGroupUsers')
      .values(userIds.map(userId => ({ groupId, userId })))
      .execute();
  }
  if (childGroupIds.length > 0) {
    await db
      .insertInto('userGroupGroups')
      .values(
        childGroupIds.map(childGroupId => ({
          parentGroupId: groupId,
          childGroupId
        }))
      )
      .execute();
  }
}

/** A user group's live members; a soft-deleted one is skipped, never blocking (§5.9), so a read-then-write round trip through `replaceMembers` needs no special case. */
export async function userGroupMembers(
  db: Transaction<DB>,
  groupId: string
): Promise<UserGroupMemberOut[]> {
  const [users, groups] = await Promise.all([
    db
      .selectFrom('userGroupUsers as ugu')
      .innerJoin('users as u', 'u.id', 'ugu.userId')
      .select('ugu.userId as userId')
      .where('ugu.groupId', '=', groupId)
      .where('u.deletedAt', 'is', null)
      .execute(),
    db
      .selectFrom('userGroupGroups as ugg')
      .innerJoin('userGroups as ug', 'ug.id', 'ugg.childGroupId')
      .select('ugg.childGroupId as childGroupId')
      .where('ugg.parentGroupId', '=', groupId)
      .where('ug.deletedAt', 'is', null)
      .execute()
  ]);
  return [
    ...users.map(row => ({ kind: 'user' as const, id: row.userId })),
    ...groups.map(row => ({ kind: 'userGroup' as const, id: row.childGroupId }))
  ];
}

/** Assembles the wire shape of a user group from its row and member list (§10.3). */
export async function toUserGroupOut(
  db: Transaction<DB>,
  row: UserGroupRow
): Promise<UserGroupOut> {
  return {
    id: row.id,
    name: row.name,
    members: await userGroupMembers(db, row.id)
  };
}
