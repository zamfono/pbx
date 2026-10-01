import type { Db } from '@zamfono/shared';

export type Recipients = { emails: string[]; name: string };

/** The group's member user ids (§11.2 `ring_group_members`), user groups flattened, nested. */
async function resolveRingGroupUserIds(
  db: Db,
  ringGroupId: string
): Promise<string[]> {
  const members = await db
    .selectFrom('ringGroupMembers')
    .select(['userId', 'userGroupId'])
    .where('groupId', '=', ringGroupId)
    .execute();
  const userIds = new Set<string>();
  const pending: string[] = [];
  for (const member of members) {
    if (member.userId !== null) {
      userIds.add(member.userId);
    }
    if (member.userGroupId !== null) {
      pending.push(member.userGroupId);
    }
  }
  const visited = new Set<string>();
  for (let groupId = pending.pop(); groupId; groupId = pending.pop()) {
    if (visited.has(groupId)) {
      continue;
    }
    visited.add(groupId);
    // eslint-disable-next-line no-await-in-loop -- each group's children extend `pending`, so the next iteration depends on this one
    const [groupUsers, childGroups] = await Promise.all([
      db
        .selectFrom('userGroupUsers')
        .select('userId')
        .where('groupId', '=', groupId)
        .execute(),
      db
        .selectFrom('userGroupGroups')
        .select('childGroupId')
        .where('parentGroupId', '=', groupId)
        .execute()
    ]);
    for (const row of groupUsers) {
      userIds.add(row.userId);
    }
    for (const row of childGroups) {
      pending.push(row.childGroupId);
    }
  }
  return [...userIds];
}

export async function resolveRecipients(
  db: Db,
  to: { userId: string } | { ringGroupId: string }
): Promise<Recipients> {
  if ('userId' in to) {
    const user = await db
      .selectFrom('users')
      .select(['email', 'name'])
      .where('id', '=', to.userId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return user
      ? { emails: [user.email], name: user.name }
      : { emails: [], name: '' };
  }
  const group = await db
    .selectFrom('ringGroups')
    .select('name')
    .where('id', '=', to.ringGroupId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  const userIds = await resolveRingGroupUserIds(db, to.ringGroupId);
  if (userIds.length === 0) {
    return { emails: [], name: group?.name ?? '' };
  }
  const users = await db
    .selectFrom('users')
    .select('email')
    .where('id', 'in', userIds)
    .where('deletedAt', 'is', null)
    .execute();
  return { emails: users.map(user => user.email), name: group?.name ?? '' };
}
