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
    return sql`AND COALESCE(rgm.user_id, ugu.user_id) = ${only.userId}`;
  }
  return sql`AND rgm.group_id = ${only.ringGroupId}`;
}

/**
 * Ring-group memberships (§5.3, §11.2 `ring_group_members`), direct or through a nested
 * `user_groups` tree, each user once per group, of one user, of one ring group or all of them: the
 * recursive CTE follows `user_group_groups` as deep as it nests, its cycles already rejected on
 * write (`user_group_groups_no_cycle`).
 */
export async function ringGroupMemberships(
  db: Db,
  only?: MembershipScope
): Promise<RingGroupMembership[]> {
  const { rows } = await sql<RingGroupMembership>`
    WITH RECURSIVE group_reach(root_group_id, group_id) AS (
      SELECT id, id FROM user_groups
      UNION
      SELECT gr.root_group_id, ugg.child_group_id
      FROM group_reach gr
      JOIN user_group_groups ugg ON ugg.parent_group_id = gr.group_id
    )
    SELECT DISTINCT
      rgm.group_id AS ringGroupId,
      COALESCE(rgm.user_id, ugu.user_id) AS userId
    FROM ring_group_members rgm
    LEFT JOIN group_reach gr ON gr.root_group_id = rgm.user_group_id
    LEFT JOIN user_group_users ugu ON ugu.group_id = gr.group_id
    WHERE COALESCE(rgm.user_id, ugu.user_id) IS NOT NULL ${scopeCondition(only)}
  `.execute(db);
  return rows;
}
