/**
 * The authenticated `/events` WebSocket (§10.6): a per-role filtered fan-out of every `Envelope`
 * `core` and `api` produce (§3.1 "Events"), to sockets `eventsAuth.ts`'s first-frame token auth
 * has admitted.
 */
import pino from 'pino';
import { WebSocket } from 'ws';

import {
  MAX_TIMER_MS,
  nowIso,
  publicEnvelope,
  type Db,
  type Envelope,
  type Event
} from '@zamfono/shared';

import type { Authenticated } from './auth/bearer.js';
import { livePersonalAccessTokenIds } from './auth/personalAccessTokens.js';
import { liveSessionIds } from './auth/tokens.js';
import type { Actor } from './ops/types.js';
import { ringGroupMemberships } from './ringGroupMembership.js';
import { serialQueue } from './serialQueue.js';

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

const logger = pino({ name: 'events' });

/** An open socket: who it authenticated as, with which session or token, and its ring groups. */
type Subscription = { auth: Authenticated; ringGroupIds: ReadonlySet<string> };

// §10.6: the close code of a socket whose user is gone or whose role changed, or whose session or
// personal access token ended.
const USER_CHANGED_CLOSE_CODE = 4401;

/** The ring group ids each user may see mailbox events for (§5.3, `ringGroupMemberships`). */
async function ringGroupIdsByUser(db: Db): Promise<Map<string, Set<string>>> {
  const rows = await ringGroupMemberships(db);
  const byUser = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = byUser.get(row.userId) ?? new Set<string>();
    ids.add(row.ringGroupId);
    byUser.set(row.userId, ids);
  }
  return byUser;
}

/** `auth`'s subscription from `byUser`: no ring group for an admin, who sees every mailbox. */
function subscription(
  auth: Authenticated,
  byUser: ReadonlyMap<string, Set<string>>
): Subscription {
  const { actor } = auth;
  const ringGroupIds = actor.role === 'user' ? byUser.get(actor.id) : undefined;
  return { auth, ringGroupIds: ringGroupIds ?? new Set<string>() };
}

/** Whether the session or personal access token `auth` opened its socket with is still live. */
function credentialLive(
  auth: Authenticated,
  liveSessions: ReadonlySet<string>,
  liveTokens: ReadonlySet<string>
): boolean {
  if (auth.personalAccessToken) {
    return liveTokens.has(auth.personalAccessToken.id);
  }
  return auth.sessionId !== undefined && liveSessions.has(auth.sessionId);
}

function isVisible(sub: Subscription, ev: Event): boolean {
  if (visibleTo(sub.auth.actor, ev)) {
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
  /** Runs the re-check when the earliest personal access token of an open socket expires. */
  private expiryTimer: NodeJS.Timeout | undefined;
  /** Runs one re-check at a time, each on rows read after the one before it applied. */
  private readonly inTurn = serialQueue();

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

  /**
   * Registers a socket the handshake authenticated as `auth`, with its session or personal access
   * token, then re-checks it as `usersChanged` does, so a change committed since the handshake
   * reaches it; removes it on close or error. A socket closing already, during the handshake, is
   * not taken on: its `close` event has fired or is on its way.
   */
  subscribeWs(socket: WebSocket, auth: Authenticated): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }
    this.subscribers.set(socket, { auth, ringGroupIds: new Set<string>() });
    socket.on('close', () => {
      this.subscribers.delete(socket);
    });
    socket.on('error', () => {
      this.subscribers.delete(socket);
      socket.terminate();
    });
    return this.usersChanged();
  }

  /**
   * Re-reads the user row, ring-group memberships and session or personal access token behind
   * every open socket (§10.6): closes with 4401 a socket whose user is gone or holds another role
   * than at its handshake, or whose session or personal access token was revoked or has expired,
   * and narrows or widens the rest to their current ring groups. Runs after every committed write
   * and every session revocation, when a socket registers, and when the earliest token of an open
   * socket expires; one at a time, so an earlier re-check never overrides a later one.
   */
  usersChanged(): Promise<void> {
    return this.inTurn(() => this.recheck());
  }

  private async recheck(): Promise<void> {
    const open = [...this.subscribers];
    if (open.length === 0) {
      return;
    }
    const auths = open.map(([, sub]) => sub.auth);
    const ids = [...new Set(auths.map(auth => auth.actor.id))];
    const sessionIds = auths.flatMap(auth =>
      auth.sessionId === undefined ? [] : [auth.sessionId]
    );
    const tokenIds = auths.flatMap(auth =>
      auth.personalAccessToken ? [auth.personalAccessToken.id] : []
    );
    const now = nowIso();
    const [users, byUser, liveSessions, liveTokens] = await Promise.all([
      this.db
        .selectFrom('users')
        .select(['id', 'role'])
        .where('id', 'in', ids)
        .where('deletedAt', 'is', null)
        .execute(),
      ringGroupIdsByUser(this.db),
      liveSessionIds(this.db, sessionIds, now),
      livePersonalAccessTokenIds(this.db, tokenIds, now)
    ]);
    const roles = new Map(users.map(user => [user.id, user.role]));
    for (const [socket, sub] of open) {
      // A socket that closed while the rows were read is gone already.
      if (this.subscribers.get(socket) !== sub) {
        continue;
      }
      const { actor } = sub.auth;
      if (
        roles.get(actor.id) === actor.role &&
        credentialLive(sub.auth, liveSessions, liveTokens)
      ) {
        this.subscribers.set(socket, subscription(sub.auth, byUser));
      } else {
        this.subscribers.delete(socket);
        socket.close(USER_CHANGED_CLOSE_CODE, 'user changed');
      }
    }
    this.scheduleExpiry();
  }

  /** Sets `expiryTimer` to run the re-check when the earliest token of an open socket expires. */
  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const expiries = [...this.subscribers.values()].flatMap(sub =>
      sub.auth.personalAccessToken?.expiresAt
        ? [Date.parse(sub.auth.personalAccessToken.expiresAt)]
        : []
    );
    if (expiries.length === 0) {
      return;
    }
    // A later expiry is re-checked after `MAX_TIMER_MS` and scheduled again.
    const delayMs = Math.min(
      Math.max(Math.min(...expiries) - Date.now(), 0),
      MAX_TIMER_MS
    );
    this.expiryTimer = setTimeout(() => {
      this.usersChanged().catch((error: unknown) => {
        logger.error({ error }, '/events token expiry re-check failed');
      });
    }, delayMs);
    // A pending expiry keeps no process alive on its own.
    this.expiryTimer.unref();
  }
}
