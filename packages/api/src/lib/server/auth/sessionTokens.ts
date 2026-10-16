/**
 * A voice bot's session token (§5.2 "Session tokens", §9.4 "WebSocket targets"): `core` hands one
 * to each bot it streams a call to, and it acts, on REST alone, as that bot on that call while the
 * stream lasts. `core` holds the live tokens, so it is asked by the token's SHA-256 each time.
 */
import { createHash } from 'node:crypto';

import { SESSION_TOKEN_PREFIX } from '@zamfono/shared';

import { getCoreClient } from '../coreClient.js';
import { BEARER_PREFIX, type Authenticated } from './bearer.js';

/** The session token in `request`'s `Authorization` header, `null` for any other or none. */
export function sessionTokenOf(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith(`${BEARER_PREFIX}${SESSION_TOKEN_PREFIX}`)
    ? header.slice(BEARER_PREFIX.length)
    : null;
}

/** The bot `token` acts as, `null` once its stream has ended or for no such token. */
export async function authenticateSessionToken(
  token: string
): Promise<Authenticated | null> {
  const hash = createHash('sha256').update(token).digest('hex');
  const session = await getCoreClient()
    .callSession(hash)
    .catch(() => null);
  return (
    session && {
      actor: {
        id: session.legId,
        name: 'voice bot',
        role: 'user',
        callSession: { callId: session.callId }
      }
    }
  );
}
