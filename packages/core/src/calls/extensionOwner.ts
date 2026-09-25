/** Who owns a dialled extension, for the feature codes that take one (§9.3 "Feature codes":
 * `*5<ext>`, `*8<ext>`, `*95<ext>`, `*97<ext>`), and a ring group's members for `*95`'s
 * permission check (§10.2 "Mailbox access"). Its coverage lives in `features.test.ts` alongside
 * the feature codes'. */
import type { Snapshot } from '../internal/server.js';
import { expandMembers } from '../routing/ringGroup.js';
import type { Owner } from './call.js';

/** The user or ring group owning `ext`, `null` for an unowned or parking-slot one. */
export function ownerForExt(snapshot: Snapshot, ext: string): Owner | null {
  const row = snapshot.extensions.find(candidate => candidate.ext === ext);
  if (row === undefined) {
    return null;
  }
  if (row.userId !== null) {
    return { userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { ringGroupId: row.ringGroupId };
  }
  return null;
}

/** `groupId`'s member user ids: `ring_group_members` rows taken directly, and each user-group row
 * flattened through `userGroupUsers`/`userGroupGroups` (nested groups included), the same
 * expansion `routing/ringGroup.ts`'s own ring plan uses (§11.2 `ring_group_members`'s exclusive
 * arc `user_id`/`user_group_id`). */
export function ringGroupMemberIds(
  snapshot: Snapshot,
  groupId: string
): Set<string> {
  const userGroupUsers = new Map<string, string[]>();
  for (const row of snapshot.userGroupUsers) {
    const list = userGroupUsers.get(row.groupId) ?? [];
    list.push(row.userId);
    userGroupUsers.set(row.groupId, list);
  }
  const userGroupGroups = new Map<string, string[]>();
  for (const row of snapshot.userGroupGroups) {
    const list = userGroupGroups.get(row.parentGroupId) ?? [];
    list.push(row.childGroupId);
    userGroupGroups.set(row.parentGroupId, list);
  }
  const liveUserIds = new Set(
    snapshot.users.filter(user => user.deletedAt === null).map(user => user.id)
  );
  const memberRows = snapshot.ringGroupMembers.filter(
    row => row.groupId === groupId
  );
  return new Set(
    expandMembers(
      groupId,
      memberRows,
      userGroupUsers,
      userGroupGroups,
      liveUserIds
    )
  );
}
