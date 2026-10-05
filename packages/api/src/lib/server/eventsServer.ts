/**
 * The `/events` WebSocket's server side (§10.6): the upgrade of `GET /events` on `api`'s HTTP
 * server, the first-frame auth `eventsAuth.ts` runs, and the hand-over of an admitted socket to
 * the `EventHub`.
 */
import type http from 'node:http';
import pino from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';

import type { Db } from '@zamfono/shared';

import type { EventHub } from './events.js';
import { authenticateEventsSocket } from './eventsAuth.js';

const EVENTS_PATH = '/events';
// The only frame a client sends is the auth frame, a token of well under 1 KiB in a small JSON
// object; `ws` closes a socket with 1009 on a larger frame before buffering it.
const MAX_FRAME_BYTES = 4096;
const logger = pino({ name: 'events' });

export type EventsServerDeps = { hub: EventHub; db: Db; jwtSecret: string };

/** Runs the `/events` auth handshake on an upgraded socket, then registers it with the hub. */
async function acceptEventsSocket(
  socket: WebSocket,
  { hub, db, jwtSecret }: EventsServerDeps
): Promise<void> {
  // `ws` reports a protocol violation, such as a frame over `MAX_FRAME_BYTES`, as an `'error'`
  // event, which Node throws when no listener is attached; it closes the socket itself.
  socket.on('error', () => {
    socket.terminate();
  });
  try {
    const auth = await authenticateEventsSocket(socket, { db, jwtSecret });
    if (auth) {
      await hub.subscribeWs(socket, auth);
    }
  } catch (error) {
    logger.error({ err: error }, '/events socket setup failed');
    socket.terminate();
  }
}

/** Serves `/events` on `server`'s upgrades; an upgrade of any other path is refused. */
export function attachEventsServer(
  server: http.Server,
  deps: EventsServerDeps
): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES
  });
  wss.on('error', (error: unknown) => {
    logger.error({ err: error }, '/events WebSocket server error');
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== EVENTS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      acceptEventsSocket(ws, deps).catch((error: unknown) => {
        logger.error({ err: error }, '/events socket accept failed');
      });
    });
  });
}
