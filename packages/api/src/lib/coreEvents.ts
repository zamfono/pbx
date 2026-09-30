/**
 * Subscribes to `core`'s internal `/internal/events` WebSocket (§3, §3.1 "Events"): the socket
 * carries unauthenticated `CoreStreamFrame` JSON frames, since the internal Docker network is the
 * trust boundary, and a dropped connection reconnects.
 */
import { WebSocket } from 'ws';

import {
  rawDataToString,
  type CoreStreamFrame,
  type Envelope
} from '@zamfono/shared';

// ponytail: fixed 1 s reconnect delay; add backoff if a `core` outage causes a reconnect storm
// worth damping.
const DEFAULT_RECONNECT_DELAY_MS = 1000;

function tryParseFrame(raw: string): CoreStreamFrame | null {
  try {
    return JSON.parse(raw) as CoreStreamFrame;
  } catch {
    return null;
  }
}

export type CoreEventsDeps = {
  url: string;
  /** Every event `core` emits, for `/events` subscribers and webhooks. */
  onEvent: (envelope: Envelope) => void;
  /** `core`'s `asterisk.started` frame, `api`'s alone and never relayed (§10.4 "After a restart"). */
  onAsteriskStarted?: (asteriskStartedAt: string) => void;
  /** Each time the connection opens, the first time and after every reconnect. */
  onOpen?: () => void;
  /** Overridable in tests; the real subscriber reconnects at `DEFAULT_RECONNECT_DELAY_MS`. */
  reconnectDelayMs?: number;
};

/**
 * Connects to `deps.url` and hands every frame received to its callback, reconnecting after a
 * fixed delay whenever the connection drops or errors. `close()` stops it for good, without a
 * further reconnect.
 */
export function connectCoreEvents(deps: CoreEventsDeps): { close: () => void } {
  let closed = false;
  let socket: WebSocket | null = null;

  function scheduleReconnect(): void {
    if (closed) {
      return;
    }
    // eslint-disable-next-line no-use-before-define -- scheduleReconnect and connect call each other; connect is defined just below
    setTimeout(connect, deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
  }

  function connect(): void {
    if (closed) {
      return;
    }
    const ws = new WebSocket(deps.url);
    socket = ws;
    ws.on('open', () => {
      deps.onOpen?.();
    });
    ws.on('message', raw => {
      const frame = tryParseFrame(rawDataToString(raw));
      if (frame === null) {
        return;
      }
      if (frame.type === 'asterisk.started') {
        deps.onAsteriskStarted?.(frame.asteriskStartedAt);
        return;
      }
      deps.onEvent(frame);
    });
    ws.on('close', scheduleReconnect);
    ws.on('error', () => {
      ws.terminate();
    });
  }

  connect();
  return {
    close: () => {
      closed = true;
      socket?.close();
    }
  };
}
