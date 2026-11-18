/** The connection to a `webSocket` target's bot (§9.4 "WebSocket targets"). */
import WebSocket from 'ws';

import {
  isForbiddenAddressError,
  literalRefusal,
  urlLookup,
  type TargetPolicy
} from '@zamfono/shared';

// How long the bot's socket may take to open.
const CONNECT_TIMEOUT_MS = 10_000;
// The largest frame a bot may send: well above a second of 24 kHz linear audio as base64.
const MAX_FRAME_BYTES = 1_048_576;

/** Opens `url`, its host's addresses checked against `policy` (none with `null`), `ws://` to a
 *  private one alone: the open socket, or why not once it fails or times out (§9.4). */
export function connect(
  url: string,
  policy: TargetPolicy | null
): Promise<WebSocket | 'connectFailed' | 'forbiddenAddress'> {
  const target = new URL(url);
  if (policy !== null && literalRefusal(target, policy) !== null) {
    return Promise.resolve('forbiddenAddress');
  }
  const socket = new WebSocket(url, {
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    maxPayload: MAX_FRAME_BYTES,
    ...(policy === null ? {} : { lookup: urlLookup(target, policy) })
  });
  return new Promise(resolve => {
    socket.once('open', () => {
      resolve(socket);
    });
    socket.once('error', error => {
      resolve(
        isForbiddenAddressError(error) ? 'forbiddenAddress' : 'connectFailed'
      );
    });
    socket.once('close', () => {
      resolve('connectFailed');
    });
  });
}
