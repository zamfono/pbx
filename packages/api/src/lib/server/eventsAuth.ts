/**
 * The `/events` WebSocket's first-frame token auth (§10.6): the socket's first frame must be
 * `{ type: 'auth', token }` naming a live user, within `AUTH_TIMEOUT_MS`. `events.ts` fans out
 * to the sockets this admits.
 */
import type { WebSocket } from 'ws';

import { rawDataToString } from '@zamfono/shared';

import { authenticateToken, type BearerDeps } from './auth/bearer.js';
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

export type EventsAuthDeps = BearerDeps & {
  /** Overridable in tests; the auth handshake's real timeout is `AUTH_TIMEOUT_MS`. */
  timeoutMs?: number;
};

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
      authenticateToken(deps, frame.token)
        .then(auth => {
          if (!auth) {
            socket.close();
          }
          finish(auth?.actor ?? null);
        })
        .catch(() => {
          socket.close();
          finish(null);
        });
    };
    socket.once('message', onMessage);
  });
}
