/**
 * The session-token lookup of the internal API, `GET /internal/callSessions/{sha256}` (§5.2
 * "Session tokens"): the call and bot leg a voice bot's session token acts for while its stream
 * lasts, 404 otherwise. `api` sends the token's SHA-256 in hex, so the token never travels in a
 * URL. `server.ts` mounts `handleCallSessionRoute`.
 */
import type http from 'node:http';

import { HTTP_NOT_FOUND, HTTP_OK } from '@zamfono/shared';

import type { BotSessions } from '../calls/botSessions.js';
import { respondJson, respondProblem } from './http.js';

const CALL_SESSION_ROUTE = /^\/internal\/callSessions\/(?<hash>[0-9a-f]{64})$/u;

/** Serves the lookup; `null` when `pathname` is not on its route. */
export function handleCallSessionRoute(
  deps: { sessions: Pick<BotSessions, 'resolve'> },
  pathname: string,
  response: http.ServerResponse
): Promise<void> | null {
  const hash = CALL_SESSION_ROUTE.exec(pathname)?.groups?.hash;
  if (hash === undefined) {
    return null;
  }
  const session = deps.sessions.resolve(hash);
  if (session === null) {
    respondProblem(response, HTTP_NOT_FOUND, 'no such session');
  } else {
    respondJson(response, HTTP_OK, session);
  }
  return Promise.resolve();
}
