import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import { OpError } from '../types.js';

const STATUS_NOT_FOUND = 404;
const STATUS_UNPROCESSABLE_ENTITY = 422;

export const memberSchema = z.object({
  kind: z.enum(['user', 'userGroup']),
  id: z.string()
});
export type MemberSpec = z.infer<typeof memberSchema>;

/** Throws 422 when `members` lists the same user or user group twice (`ring_group_members`' UNIQUEs, §11.2). */
function assertMembersUnique(members: MemberSpec[]): void {
  const userIds = new Set<string>();
  const userGroupIds = new Set<string>();
  for (const member of members) {
    const seen = member.kind === 'user' ? userIds : userGroupIds;
    if (seen.has(member.id)) {
      throw new OpError(
        STATUS_UNPROCESSABLE_ENTITY,
        `ringGroups: duplicate ${member.kind} member '${member.id}'`
      );
    }
    seen.add(member.id);
  }
}

/** Throws 404 when a member names no live user or user-group row (`ring_group_members`' FKs, §11.2). */
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

export type RingGroupMemberOut = {
  position: number;
  kind: 'user' | 'userGroup';
  id: string;
};

/** One `ring_group_members` row as a member spec; the table's own CHECK keeps exactly one of `userId`/`userGroupId` set. */
function toMemberOut(row: {
  position: number;
  userId: string | null;
  userGroupId: string | null;
}): RingGroupMemberOut {
  if (row.userId !== null) {
    return { position: row.position, kind: 'user', id: row.userId };
  }
  if (row.userGroupId !== null) {
    return { position: row.position, kind: 'userGroup', id: row.userGroupId };
  }
  throw new Error('ring_group_members: row has neither userId nor userGroupId');
}

type MemberRow = {
  position: number;
  userId: string | null;
  userGroupId: string | null;
  userDeletedAt: string | null;
  groupDeletedAt: string | null;
};

/** Every `ring_group_members` row of `groupId` in ring order, with its member's `deletedAt`. */
async function loadMemberRows(
  db: Transaction<DB>,
  groupId: string
): Promise<MemberRow[]> {
  return db
    .selectFrom('ringGroupMembers as rgm')
    .leftJoin('users as u', 'u.id', 'rgm.userId')
    .leftJoin('userGroups as ug', 'ug.id', 'rgm.userGroupId')
    .select([
      'rgm.position',
      'rgm.userId',
      'rgm.userGroupId',
      'u.deletedAt as userDeletedAt',
      'ug.deletedAt as groupDeletedAt'
    ])
    .where('rgm.groupId', '=', groupId)
    .orderBy('rgm.position')
    .execute();
}

function isLive(row: MemberRow): boolean {
  return row.userId ? row.userDeletedAt === null : row.groupDeletedAt === null;
}

/** A ring group's live members; a soft-deleted one is skipped, never blocking (§5.9), so a read-then-write round trip through `replaceMembers` needs no special case. */
export async function ringGroupMembers(
  db: Transaction<DB>,
  groupId: string
): Promise<RingGroupMemberOut[]> {
  const rows = await loadMemberRows(db, groupId);
  return rows.filter(isLive).map(toMemberOut);
}

/**
 * Replaces a ring group's ordered member list as a whole (§10.3 "Ring groups"). `members` is the
 * live list, the one a read returns; a link to a soft-deleted member keeps its old position, or
 * the end where the new list is shorter, so the membership survives the member's delete and undo
 * round-trip (§5.9, §11.1 "the membership tables").
 */
export async function replaceMembers(
  db: Transaction<DB>,
  groupId: string,
  members: MemberSpec[]
): Promise<void> {
  assertMembersUnique(members);
  await assertMembersAvailable(db, members);
  const merged = [...members];
  const parked = (await loadMemberRows(db, groupId)).filter(
    row => !isLive(row)
  );
  for (const row of parked) {
    const { kind, id } = toMemberOut(row);
    merged.splice(Math.min(row.position, merged.length), 0, { kind, id });
  }
  await db
    .deleteFrom('ringGroupMembers')
    .where('groupId', '=', groupId)
    .execute();
  if (merged.length === 0) {
    return;
  }
  await db
    .insertInto('ringGroupMembers')
    .values(
      merged.map((member, position) => ({
        groupId,
        position,
        userId: member.kind === 'user' ? member.id : null,
        userGroupId: member.kind === 'userGroup' ? member.id : null
      }))
    )
    .execute();
}
