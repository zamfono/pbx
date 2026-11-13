import type { Db, MailboxOwner } from '@zamfono/shared';

import { ringGroupMemberships } from '../ringGroupMembership.js';

/** `toOwner`: an owner is among the addressees, so no admin's template may be used (§10.2). */
export type Recipients = { emails: string[]; name: string; toOwner: boolean };

/** The addresses mail to `to` goes to; a user without an e-mail (§11.2) is none of them. */
export async function resolveRecipients(
  db: Db,
  to: MailboxOwner
): Promise<Recipients> {
  if ('userId' in to) {
    const user = await db
      .selectFrom('users')
      .select(['email', 'name', 'role'])
      .where('id', '=', to.userId)
      .where('email', 'is not', null)
      .where('deletedAt', 'is', null)
      .$narrowType<{ email: string }>()
      .executeTakeFirst();
    return user
      ? {
          emails: [user.email],
          name: user.name,
          toOwner: user.role === 'owner'
        }
      : { emails: [], name: '', toOwner: false };
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
    return { emails: [], name: group?.name ?? '', toOwner: false };
  }
  const users = await db
    .selectFrom('users')
    .select(['email', 'role'])
    .where('id', 'in', userIds)
    .where('email', 'is not', null)
    .where('deletedAt', 'is', null)
    .$narrowType<{ email: string }>()
    .execute();
  return {
    emails: users.map(user => user.email),
    name: group?.name ?? '',
    toOwner: users.some(user => user.role === 'owner')
  };
}
