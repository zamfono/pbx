import { sql, type RawBuilder } from 'kysely';

import type { Db } from '@zamfono/shared';

export type RingGroupMembership = { ringGroupId: string; userId: string };

type MembershipScope = { userId: string } | { ringGroupId: string };

function scopeCondition(
  only: MembershipScope | undefined
): RawBuilder<unknown> {
  if (only === undefined) {
    return sql``;
  }
  if ('userId' in only) {
    return sql`AND u.id = ${only.userId}`;
  }
  return sql`AND rgm.group_id = ${only.ringGroupId}`;
}

/**
 * Live ring-group memberships (§5.3, §11.2 `ring_group_members`), direct or through a nested
 * `user_groups` tree, each user once per group, of one user, of one ring group or all of them: the
 * recursive CTE follows `user_group_groups` as deep as it nests, its cycles already rejected on
 * write (`user_group_groups_no_cycle`). A soft-deleted ring group, user group or user keeps its
 * membership rows and is skipped meanwhile (§5.9), as `core` skips it in a ring plan.
 */
export async function ringGroupMemberships(
  db: Db,
  only?: MembershipScope
): Promise<RingGroupMembership[]> {
  const { rows } = await sql<RingGroupMembership>`
    WITH RECURSIVE group_reach(root_group_id, group_id) AS (
      SELECT id, id FROM user_groups WHERE deleted_at IS NULL
      UNION
      SELECT gr.root_group_id, ugg.child_group_id
      FROM group_reach gr
      JOIN user_group_groups ugg ON ugg.parent_group_id = gr.group_id
      JOIN user_groups child ON child.id = ugg.child_group_id
      WHERE child.deleted_at IS NULL
    )
    SELECT DISTINCT
      rgm.group_id AS ringGroupId,
      u.id AS userId
    FROM ring_group_members rgm
    JOIN ring_groups rg ON rg.id = rgm.group_id AND rg.deleted_at IS NULL
    LEFT JOIN group_reach gr ON gr.root_group_id = rgm.user_group_id
    LEFT JOIN user_group_users ugu ON ugu.group_id = gr.group_id
    JOIN users u ON u.id = COALESCE(rgm.user_id, ugu.user_id)
    WHERE u.deleted_at IS NULL ${scopeCondition(only)}
  `.execute(db);
  return rows;
}
