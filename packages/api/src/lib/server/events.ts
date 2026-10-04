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
import { ringGroupMemberships } from './ringGroupMembership.js';

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

// §10.6: the close code of a socket whose user is gone or whose role changed.
const USER_CHANGED_CLOSE_CODE = 4401;

/**
 * The ring group ids each user, or only `userId`, may see mailbox events for (§5.3,
 * `ringGroupMemberships`).
 */
async function ringGroupIdsByUser(
  db: Db,
  userId?: string
): Promise<Map<string, Set<string>>> {
  const rows = await ringGroupMemberships(
    db,
    userId === undefined ? undefined : { userId }
  );
  const byUser = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = byUser.get(row.userId) ?? new Set<string>();
    ids.add(row.ringGroupId);
    byUser.set(row.userId, ids);
  }
  return byUser;
}

/** `actor`'s subscription from `byUser`: no ring group for an admin, who sees every mailbox. */
function subscription(
  actor: Actor,
  byUser: ReadonlyMap<string, Set<string>>
): Subscription {
  const ringGroupIds = actor.role === 'user' ? byUser.get(actor.id) : undefined;
  return { actor, ringGroupIds: ringGroupIds ?? new Set<string>() };
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
    const byUser = await ringGroupIdsByUser(this.db, actor.id);
    this.subscribers.set(socket, subscription(actor, byUser));
    socket.on('close', () => {
      this.subscribers.delete(socket);
    });
    socket.on('error', () => {
      this.subscribers.delete(socket);
      socket.terminate();
    });
  }

  /**
   * Re-reads the user row and ring-group memberships behind every open socket (§10.6): closes
   * with 4401 a socket whose user is gone or holds another role than at its handshake, and
   * narrows or widens the rest to their current ring groups.
   */
  async usersChanged(): Promise<void> {
    const open = [...this.subscribers];
    if (open.length === 0) {
      return;
    }
    const ids = [...new Set(open.map(([, sub]) => sub.actor.id))];
    const [users, byUser] = await Promise.all([
      this.db
        .selectFrom('users')
        .select(['id', 'role'])
        .where('id', 'in', ids)
        .where('deletedAt', 'is', null)
        .execute(),
      ringGroupIdsByUser(this.db)
    ]);
    const roles = new Map(users.map(user => [user.id, user.role]));
    for (const [socket, sub] of open) {
      // A socket that closed while the rows were read is gone already.
      if (this.subscribers.get(socket) !== sub) {
        continue;
      }
      if (roles.get(sub.actor.id) === sub.actor.role) {
        this.subscribers.set(socket, subscription(sub.actor, byUser));
      } else {
        this.subscribers.delete(socket);
        socket.close(USER_CHANGED_CLOSE_CODE, 'user changed');
      }
    }
  }
}
