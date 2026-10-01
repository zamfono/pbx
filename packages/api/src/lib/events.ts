/**
 * The authenticated `/events` WebSocket (§10.6): a per-role filtered fan-out of every `Envelope`
 * `core` and `api` produce (§3.1 "Events"), to sockets `eventsAuth.ts`'s first-frame token auth
 * has admitted.
 */
import { WebSocket } from 'ws';

import {
  publicEnvelope,
  type Db,
  type Envelope,
  type Event
} from '@zamfono/shared';

import type { Actor } from './ops/types.js';

const RING_GROUP_MAILBOX_PREFIX = 'ringGroup:';
const USER_MAILBOX_PREFIX = 'user:';

/**
 * Whether `actor` may see `ev` on `/events` (§10.6): `admin`/`owner` see everything, a `user`
 * only their own presence and calls plus the tenant-scope `ooo`/`hours` events. Ring-group
 * mailbox visibility for `voicemail.new` needs the caller's group memberships, which `EventHub`
 * checks separately since this function takes no database.
 */
export function visibleTo(actor: Actor, ev: Event): boolean {
  if (ev.type === 'call.state' && ev.usersOnly === true) {
    // The call starting or stopping being these users' own while its state is unchanged: news to
    // them alone, since an admin already has every event of the call.
    return actor.role === 'user' && ev.userIds.includes(actor.id);
  }
  if (actor.role !== 'user') {
    return true;
  }
  switch (ev.type) {
    case 'presence':
      return ev.userId === actor.id;
    case 'call.state':
      // Any participant's own call (§10.6), which `userId` alone names only for the answerer or
      // callee: a call the user placed or was rung for counts too.
      return ev.userId === actor.id || ev.userIds.includes(actor.id);
    case 'voicemail.new':
      return ev.mailbox === `${USER_MAILBOX_PREFIX}${actor.id}`;
    case 'ooo':
    case 'hours':
      return ev.scope === 'tenant';
    default:
      return false;
  }
}

type Subscription = { actor: Actor; ringGroupIds: ReadonlySet<string> };

/**
 * The ring group ids `userId` may see mailbox events for (§5.3): groups `userId` is a direct
 * member of, plus groups whose membership includes a user group `userId` belongs to, nested
 * arbitrarily deep through `user_group_groups` (§11.2). Mirrors `resolveRingGroupUserIds` in
 * `mail/recipients.ts`, walked in reverse: up from the user to its ancestor groups rather than
 * down from a group to its member users.
 */
async function ringGroupIdsFor(db: Db, userId: string): Promise<Set<string>> {
  const direct = await db
    .selectFrom('ringGroupMembers')
    .select('groupId')
    .where('userId', '=', userId)
    .execute();
  const groupIds = new Set(direct.map(row => row.groupId));

  const ownGroups = await db
    .selectFrom('userGroupUsers')
    .select('groupId')
    .where('userId', '=', userId)
    .execute();
  const ancestorGroupIds = new Set(ownGroups.map(row => row.groupId));
  const pending = [...ancestorGroupIds];
  for (let groupId = pending.pop(); groupId; groupId = pending.pop()) {
    // eslint-disable-next-line no-await-in-loop -- each ancestor's parents extend `pending`, so the next iteration depends on this one
    const parents = await db
      .selectFrom('userGroupGroups')
      .select('parentGroupId')
      .where('childGroupId', '=', groupId)
      .execute();
    for (const row of parents) {
      if (!ancestorGroupIds.has(row.parentGroupId)) {
        ancestorGroupIds.add(row.parentGroupId);
        pending.push(row.parentGroupId);
      }
    }
  }
  if (ancestorGroupIds.size > 0) {
    const viaGroups = await db
      .selectFrom('ringGroupMembers')
      .select('groupId')
      .where('userGroupId', 'in', [...ancestorGroupIds])
      .execute();
    for (const row of viaGroups) {
      groupIds.add(row.groupId);
    }
  }
  return groupIds;
}

function isVisible(sub: Subscription, ev: Event): boolean {
  if (visibleTo(sub.actor, ev)) {
    return true;
  }
  return (
    ev.type === 'voicemail.new' &&
    ev.mailbox.startsWith(RING_GROUP_MAILBOX_PREFIX) &&
    sub.ringGroupIds.has(ev.mailbox.slice(RING_GROUP_MAILBOX_PREFIX.length))
  );
}

/** Fans out `Envelope`s from `core` and `api`'s own jobs to authenticated `/events` sockets. */
export class EventHub {
  private readonly db: Db;
  private readonly subscribers = new Map<WebSocket, Subscription>();

  constructor(db: Db) {
    this.db = db;
  }

  /** Sends `ev` to every connected socket `visibleTo` (plus ring-group mailboxes) admits. */
  publish(ev: Envelope): void {
    for (const [socket, sub] of this.subscribers) {
      if (socket.readyState !== WebSocket.OPEN || !isVisible(sub, ev)) {
        continue;
      }
      socket.send(JSON.stringify(publicEnvelope(ev)));
    }
  }

  /** Registers an already-authenticated socket; removes it on close or error. */
  async subscribeWs(socket: WebSocket, actor: Actor): Promise<void> {
    // ponytail: ring-group membership is resolved once, at subscribe time, and held for the
    // socket's life; a membership change takes effect on the next reconnect. Re-read it per
    // `voicemail.new` if that staleness window matters.
    const ringGroupIds =
      actor.role === 'user'
        ? await ringGroupIdsFor(this.db, actor.id)
        : new Set<string>();
    this.subscribers.set(socket, { actor, ringGroupIds });
    socket.on('close', () => {
      this.subscribers.delete(socket);
    });
    socket.on('error', () => {
      this.subscribers.delete(socket);
      socket.terminate();
    });
  }
}
