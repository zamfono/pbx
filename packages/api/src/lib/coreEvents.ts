/**
 * Subscribes to `core`'s internal `/internal/events` WebSocket (§3, §3.1 "Events"): the socket
 * carries unauthenticated `Envelope` JSON frames, since the internal Docker network is the trust
 * boundary, and a dropped connection reconnects.
 */
import { WebSocket } from 'ws';

import type { Envelope } from '@zamfono/shared';

import { rawDataToString } from './events.js';

// ponytail: fixed 1 s reconnect delay; add backoff if a `core` outage causes a reconnect storm
// worth damping.
const DEFAULT_RECONNECT_DELAY_MS = 1000;

function tryParseEnvelope(raw: string): Envelope | null {
  try {
    return JSON.parse(raw) as Envelope;
  } catch {
    return null;
  }
}

export type CoreEventsDeps = {
  url: string;
  onEvent: (envelope: Envelope) => void;
  /** Overridable in tests; the real subscriber reconnects at `DEFAULT_RECONNECT_DELAY_MS`. */
  reconnectDelayMs?: number;
};

/**
 * Connects to `deps.url` and calls `deps.onEvent` for every `Envelope` frame received,
 * reconnecting after a fixed delay whenever the connection drops or errors. `close()` stops it
 * for good, without a further reconnect.
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
    ws.on('message', raw => {
      const envelope = tryParseEnvelope(rawDataToString(raw));
      if (envelope) {
        deps.onEvent(envelope);
      }
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
