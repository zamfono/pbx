/**
 * The `/events` WebSocket's first-frame token auth (§10.6): the socket's first frame must be
 * `{ type: 'auth', token }` naming a live user, within `AUTH_TIMEOUT_MS`. `events.ts` fans out
 * to the sockets this admits.
 */
import type { WebSocket } from 'ws';

import { MS_PER_SECOND, rawDataToString, type Db } from '@zamfono/shared';

import { isRole, verifyAccessToken } from './auth/jwt.js';
import { tryParseJson } from './json.js';
import type { Actor } from './ops/types.js';

// §10.6: a connection that sends anything other than the auth frame first, or nothing, within
// this many milliseconds, is closed.
const AUTH_TIMEOUT_MS = 5000;

type AuthFrame = { type: 'auth'; token: string };

function parseAuthFrame(raw: string): AuthFrame | null {
  const parsed = tryParseJson(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { type, token } = parsed as Record<string, unknown>;
  return type === 'auth' && typeof token === 'string' ? { type, token } : null;
}

export type EventsAuthDeps = {
  db: Db;
  jwtSecret: string;
  /** Overridable in tests; the auth handshake's real timeout is `AUTH_TIMEOUT_MS`. */
  timeoutMs?: number;
  now?: () => number;
};

/** The live user behind `token`, or `null` for an expired/invalid token or a deleted account. */
async function actorForToken(
  deps: EventsAuthDeps,
  token: string
): Promise<Actor | null> {
  const nowS = Math.floor((deps.now?.() ?? Date.now()) / MS_PER_SECOND);
  const claims = await verifyAccessToken(deps.jwtSecret, token, nowS);
  if (!claims) {
    return null;
  }
  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'name', 'role', 'deletedAt'])
    .where('id', '=', claims.sub)
    .executeTakeFirst();
  if (user?.deletedAt !== null) {
    return null;
  }
  return {
    id: user.id,
    name: user.name,
    role: isRole(user.role) ? user.role : claims.role
  };
}

/**
 * Waits for the socket's first frame, expects `{ type: 'auth', token }`, and resolves the
 * `Actor` it names. Closes the socket and resolves `null` on a wrong first frame, an invalid
 * token, or silence past `deps.timeoutMs`/`AUTH_TIMEOUT_MS` (§10.6).
 */
export function authenticateEventsSocket(
  socket: WebSocket,
  deps: EventsAuthDeps
): Promise<Actor | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (actor: Actor | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      // eslint-disable-next-line no-use-before-define -- finish, timer and onMessage form one closure; finish only ever runs after both exist
      clearTimeout(timer);
      // eslint-disable-next-line no-use-before-define -- finish, timer and onMessage form one closure; finish only ever runs after both exist
      socket.removeListener('message', onMessage);
      resolve(actor);
    };
    const timer = setTimeout(() => {
      socket.close();
      finish(null);
    }, deps.timeoutMs ?? AUTH_TIMEOUT_MS);
    const onMessage = (raw: WebSocket.RawData): void => {
      const frame = parseAuthFrame(rawDataToString(raw));
      if (!frame) {
        socket.close();
        finish(null);
        return;
      }
      actorForToken(deps, frame.token)
        .then(actor => {
          if (!actor) {
            socket.close();
          }
          finish(actor);
        })
        .catch(() => {
          socket.close();
          finish(null);
        });
    };
    socket.once('message', onMessage);
  });
}
