/**
 * The links an after-call request's recordings carry (§10.6 "After-call requests"): a token per
 * recording, minted for one delivery attempt and stored nowhere, that opens the recording's
 * audio, deletes the recording, or both, without a user. `hooks.server.ts` authenticates a
 * request by it; the delete it allows is audited as the after-call request's.
 */
import { epochSeconds } from '@zamfono/shared';

import type { Actor } from '../ops/types.js';
import { ACCESS_TOKEN_PARAM, type Authenticated } from './bearer.js';
import { encodeRecordingToken, verifyRecordingToken } from './jwt.js';

/** How long a recording link opens: enough for a receiver to fetch and file the audio. */
export const RECORDING_LINK_TTL_S = 3600;

const RECORDINGS_PATH = '/api/v1/recordings/';
const AUDIO_SUFFIX = '/audio';

/** The actor a recording link acts as (§5.7): the after-call request of its forward target. */
export function afterCallActor(forwardTargetId: string): Actor {
  return {
    id: forwardTargetId,
    name: `after-call request of forward target ${forwardTargetId}`,
    role: 'admin',
    recordingLink: true
  };
}

/**
 * The links of recording `recordingId` for `scope`, valid for an hour from `nowMs`:
 * `downloadUrl`, a `GET` of which answers the audio, and `deleteUrl`, a `DELETE` of which removes
 * the recording at once and for good.
 */
export async function recordingLinks(
  deps: { jwtSecret: string; origin: string },
  recording: { id: string; forwardTargetId: string },
  scope: ('download' | 'delete')[],
  nowMs: number
): Promise<{ downloadUrl?: string; deleteUrl?: string }> {
  if (scope.length === 0) {
    return {};
  }
  const path = `${RECORDINGS_PATH}${recording.id}`;
  const iat = epochSeconds(nowMs);
  const token = await encodeRecordingToken(deps.jwtSecret, {
    ft: recording.forwardTargetId,
    scope,
    aud: path,
    iat,
    exp: iat + RECORDING_LINK_TTL_S
  });
  const query = `${ACCESS_TOKEN_PARAM}=${token}`;
  return {
    ...(scope.includes('download')
      ? { downloadUrl: `${deps.origin}${path}${AUDIO_SUFFIX}?${query}` }
      : {}),
    ...(scope.includes('delete')
      ? { deleteUrl: `${deps.origin}${path}?${query}` }
      : {})
  };
}

/**
 * The after-call request `request` acts as by the recording link token in its URL; `null`
 * without one, for one that fails, and for a request other than the `GET` of the audio or the
 * `DELETE` of the recording its token's scope allows.
 */
export async function authenticateRecordingLink(
  jwtSecret: string,
  request: { method: string; url: URL }
): Promise<Authenticated | null> {
  const { method, url } = request;
  const token = url.searchParams.get(ACCESS_TOKEN_PARAM);
  if (token === null || !url.pathname.startsWith(RECORDINGS_PATH)) {
    return null;
  }
  const isAudio = url.pathname.endsWith(AUDIO_SUFFIX);
  const path = isAudio
    ? url.pathname.slice(0, -AUDIO_SUFFIX.length)
    : url.pathname;
  const needed = isAudio ? 'download' : 'delete';
  if (method !== (isAudio ? 'GET' : 'DELETE')) {
    return null;
  }
  const claims = await verifyRecordingToken(
    jwtSecret,
    token,
    epochSeconds(Date.now()),
    path
  );
  return claims?.scope.includes(needed) === true
    ? { actor: afterCallActor(claims.ft) }
    : null;
}
