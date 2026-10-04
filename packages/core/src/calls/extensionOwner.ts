/** Who owns a dialled extension, for the feature codes that take one (§9.3 "Feature codes":
 * `*5<ext>`, `*8<ext>`, `*95<ext>`, `*97<ext>`), the extension a user or ring group owns, and a
 * ring group's members, for `*95`'s permission check (§10.2 "Mailbox access") and the group's
 * ring plan (§10.1 step 5). Its coverage lives in `features.test.ts` and
 * `ringGroupState.test.ts`. */
import type { Snapshot } from '../internal/snapshot.js';
import { expandMembers } from '../routing/ringGroup.js';
import type { Owner } from './release.js';

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

/** The extension `owner` owns, `null` for one that owns none. */
export function extensionOf(snapshot: Snapshot, owner: Owner): string | null {
  const row = snapshot.extensions.find(candidate =>
    'userId' in owner
      ? candidate.userId === owner.userId
      : candidate.ringGroupId === owner.ringGroupId
  );
  return row?.ext ?? null;
}

/** `groupId`'s member user ids in ring order: `ring_group_members` rows taken directly, and each
 * user-group row flattened through `user_group_users`/`user_group_groups` (nested groups
 * included) by `routing/ringGroup.ts`'s `expandMembers`, soft-deleted users and user groups
 * dropped (§5.9, §10.1 step 5, §11.2 `ring_group_members`'s exclusive arc
 * `user_id`/`user_group_id`). */
export function groupMemberUserIds(
  snapshot: Snapshot,
  groupId: string
): string[] {
  // The snapshot holds live user groups only, while their link rows outlive a soft delete.
  const liveGroupIds = new Set(snapshot.userGroups.map(group => group.id));
  const userGroupUsers = new Map<string, string[]>();
  for (const row of snapshot.userGroupUsers) {
    if (!liveGroupIds.has(row.groupId)) {
      continue;
    }
    const list = userGroupUsers.get(row.groupId) ?? [];
    list.push(row.userId);
    userGroupUsers.set(row.groupId, list);
  }
  const userGroupGroups = new Map<string, string[]>();
  for (const row of snapshot.userGroupGroups) {
    if (
      !liveGroupIds.has(row.parentGroupId) ||
      !liveGroupIds.has(row.childGroupId)
    ) {
      continue;
    }
    const list = userGroupGroups.get(row.parentGroupId) ?? [];
    list.push(row.childGroupId);
    userGroupGroups.set(row.parentGroupId, list);
  }
  const liveUserIds = new Set(snapshot.users.map(user => user.id));
  const memberRows = snapshot.ringGroupMembers.filter(
    row => row.groupId === groupId
  );
  return expandMembers(
    groupId,
    memberRows,
    userGroupUsers,
    userGroupGroups,
    liveUserIds
  );
}

/** `groupId`'s member user ids (`groupMemberUserIds`) as a set, for `*95`'s membership check. */
export function ringGroupMemberIds(
  snapshot: Snapshot,
  groupId: string
): Set<string> {
  return new Set(groupMemberUserIds(snapshot, groupId));
}
