import type { Db, MailboxOwner } from '@zamfono/shared';

import { ringGroupMemberships } from '../ringGroupMembership.js';

export type Recipients = { emails: string[]; name: string };

export async function resolveRecipients(
  db: Db,
  to: MailboxOwner
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
  const userIds = (
    await ringGroupMemberships(db, { ringGroupId: to.ringGroupId })
  ).map(row => row.userId);
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
