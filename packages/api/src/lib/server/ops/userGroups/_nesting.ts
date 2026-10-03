import type { Transaction } from 'kysely';

import { HTTP_CONFLICT, type DB } from '@zamfono/shared';

import { OpError } from '../types.js';

/** One `user_group_groups` edge, as loaded for a cycle check. */
export type Edge = { parentGroupId: string; childGroupId: string };

/** Every nesting edge except `excludeParentId`'s own outgoing ones, about to be replaced. */
export async function loadEdgesExcludingParent(
  db: Transaction<DB>,
  excludeParentId: string
): Promise<Edge[]> {
  return db
    .selectFrom('userGroupGroups')
    .select(['parentGroupId', 'childGroupId'])
    .where('parentGroupId', '!=', excludeParentId)
    .execute();
}

/** The shortest chain of edges from `fromId` to `toId`, inclusive of both ends, or `null`. */
function findPath(
  edges: Edge[],
  fromId: string,
  toId: string
): string[] | null {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.parentGroupId) ?? [];
    list.push(edge.childGroupId);
    children.set(edge.parentGroupId, list);
  }
  const predecessor = new Map<string, string>();
  const visited = new Set([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    if (current === toId) {
      const path = [toId];
      for (let node = toId; node !== fromId;) {
        const prev = predecessor.get(node);
        if (prev === undefined) {
          break;
        }
        path.unshift(prev);
        node = prev;
      }
      return path;
    }
    for (const next of children.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        predecessor.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

/**
 * Refuses nesting `childId` under `parentId` when `parentId` already lies on `childId`'s own
 * nesting chain, which would close a loop; the `user_group_groups_no_cycle` trigger is this
 * check's backstop against a race (§11.2).
 */
export function assertNoCycle(
  parentId: string,
  childId: string,
  edges: Edge[]
): void {
  if (parentId === childId) {
    throw new OpError(
      HTTP_CONFLICT,
      'user group nesting would create a cycle',
      {
        path: [parentId, childId]
      }
    );
  }
  const path = findPath(edges, childId, parentId);
  if (path) {
    throw new OpError(
      HTTP_CONFLICT,
      'user group nesting would create a cycle',
      {
        path: [parentId, ...path]
      }
    );
  }
}
