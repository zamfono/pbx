/**
 * User groups (`ops/userGroups/`, admin): nestable sets of users for ring-group membership and
 * outbound-route caller lists. Members replace as a whole; a nesting that closes a loop is
 * refused. A delete never blocks: ring groups and routes naming the group skip it while it is
 * deleted (§5.9).
 */
import { conflict, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { Db, Member, UserGroup } from '../../types';
import { defineOp } from '../core';
import { requireText } from '../validate';
import { softDeleteConfirm } from './users';

function liveGroup(db: Db, id: string): UserGroup {
  const group = db.userGroups.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (group === undefined) {
    throw notFound('userGroup', id);
  }
  return group;
}

const isLiveMember = (db: Db, member: Member): boolean =>
  member.kind === 'user'
    ? db.users.some(user => user.id === member.id && user.deletedAt === null)
    : db.userGroups.some(
        group => group.id === member.id && group.deletedAt === null
      );

/** A group as the wire carries it: its live members (`userGroupMembers`). */
const toOut = (db: Db, group: UserGroup): UserGroup => ({
  ...group,
  members: group.members.filter(member => isLiveMember(db, member))
});

function assertNameAvailable(db: Db, name: string, excludeId?: string): void {
  const holder = db.userGroups.find(
    group =>
      group.deletedAt === null &&
      group.id !== excludeId &&
      group.name.toLowerCase() === name.toLowerCase()
  );
  if (holder !== undefined) {
    throw conflict('people.groupNameTaken', 'userGroups: name already in use', [
      { kind: 'userGroup', id: holder.id, label: holder.name }
    ]);
  }
}

/** `assertMembersValid`: no member twice (422), every member live (404). */
function checkMembers(db: Db, members: Member[]): void {
  const seen = new Set<string>();
  for (const member of members) {
    const key = `${member.kind}:${member.id}`;
    if (seen.has(key)) {
      throw invalid(
        'members',
        'people.duplicateMember',
        `userGroups: duplicate ${member.kind} member '${member.id}'`
      );
    }
    seen.add(key);
    if (!isLiveMember(db, member)) {
      throw notFound(member.kind, member.id);
    }
  }
}

/** `assertNoCycle`: the shortest nesting chain from `childId` back to `parentId`, or null. */
export function nestingPath(
  db: Db,
  parentId: string,
  childId: string
): string[] | null {
  if (parentId === childId) {
    return [parentId, childId];
  }
  const children = (id: string): string[] =>
    id === parentId
      ? []
      : (db.userGroups.find(group => group.id === id)?.members ?? [])
          .filter(member => member.kind === 'userGroup')
          .map(member => member.id);
  const predecessor = new Map<string, string>();
  const queue = [childId];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of children(current)) {
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      predecessor.set(next, current);
      if (next === parentId) {
        const path = [next];
        for (let node = next; node !== childId;) {
          node = predecessor.get(node) as string;
          path.unshift(node);
        }
        return [parentId, ...path];
      }
      queue.push(next);
    }
  }
  return null;
}

function assertNoCycles(db: Db, groupId: string, members: Member[]): void {
  for (const member of members.filter(each => each.kind === 'userGroup')) {
    const path = nestingPath(db, groupId, member.id);
    if (path !== null) {
      const names = path.map(
        id => db.userGroups.find(group => group.id === id)?.name ?? id
      );
      throw conflict(
        'people.groupCycle',
        'user group nesting would create a cycle',
        [...new Set(path)].map(id => ({
          kind: 'userGroup',
          id,
          label: db.userGroups.find(group => group.id === id)?.name ?? id
        })),
        { path: names.join(' → ') }
      );
    }
  }
}

/** The new member list, keeping links to soft-deleted members (they survive a delete's undo). */
function replaceMembers(db: Db, group: UserGroup, members: Member[]): Member[] {
  return [
    ...group.members.filter(member => !isLiveMember(db, member)),
    ...members.map(member => ({ ...member }))
  ];
}

defineOp<
  { limit?: number; cursor?: string },
  { items: UserGroup[]; nextCursor: string | null }
>({
  name: 'userGroups.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.userGroups
      .filter(group => group.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(group => toOut(ctx.db, group)),
    nextCursor: null
  })
});

defineOp<{ id: string }, UserGroup>({
  name: 'userGroups.get',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => toOut(ctx.db, liveGroup(ctx.db, input.id))
});

defineOp<{ name: string; members?: Member[] }, UserGroup>({
  name: 'userGroups.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const name = requireText('name', input.name);
    assertNameAvailable(ctx.db, name);
    const members = input.members ?? [];
    checkMembers(ctx.db, members);
    const group: UserGroup = {
      id: newId(),
      name,
      members: members.map(member => ({ ...member })),
      createdAt: ctx.now,
      deletedAt: null
    };
    assertNoCycles(ctx.db, group.id, members);
    ctx.insert('userGroups', group);
    ctx.audit({
      entityKind: 'userGroup',
      entityId: group.id,
      changes: [
        ...(input.members === undefined
          ? []
          : [{ field: 'members', from: [], to: members }]),
        { field: 'name', from: null, to: name }
      ]
    });
    return toOut(ctx.db, group);
  }
});

defineOp<{ id: string; name?: string; members?: Member[] }, UserGroup>({
  name: 'userGroups.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const before = liveGroup(ctx.db, input.id);
    const name =
      input.name === undefined ? before.name : requireText('name', input.name);
    if (name !== before.name) {
      assertNameAvailable(ctx.db, name, before.id);
    }
    let members = before.members;
    if (input.members !== undefined) {
      checkMembers(ctx.db, input.members);
      assertNoCycles(ctx.db, before.id, input.members);
      members = replaceMembers(ctx.db, before, input.members);
    }
    const after: UserGroup = { ...before, name, members };
    ctx.put('userGroups', after);
    ctx.audit({
      entityKind: 'userGroup',
      entityId: after.id,
      changes: [
        ...(name === before.name
          ? []
          : [{ field: 'name', from: before.name, to: name }]),
        ...(input.members === undefined
          ? []
          : [
              {
                field: 'members',
                from: toOut(ctx.db, before).members,
                to: input.members
              }
            ])
      ]
    });
    return toOut(ctx.db, after);
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'userGroups.delete',
  minRole: 'admin',
  confirm: (ctx, input) =>
    softDeleteConfirm(
      ctx,
      'userGroups.delete',
      liveGroup(ctx.db, input.id).name
    ),
  run: (ctx, input) => {
    const group = liveGroup(ctx.db, input.id);
    const before = { ...group };
    ctx.softDelete('userGroups', group.id);
    ctx.audit({
      entityKind: 'userGroup',
      entityId: group.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: group.id };
  }
});
