/**
 * The internal event stream, `GET /internal/events` upgraded to a WebSocket (§3.1): every frame
 * the `EventBus` publishes, to every connected `api`.
 */
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import type { Logger } from '../ari/types.js';
import type { EventBus } from './eventBus.js';

/**
 * `ws` reports a receiver protocol violation or a broken pipe as an `'error'` event, which Node
 * throws when no listener is attached; the server, every accepted socket and every send carry
 * one, so a single bad frame or peer never takes core's Stasis app down with it (§3.1
 * "Independence").
 */
export function attachEventStream(
  server: http.Server,
  deps: { bus: EventBus; log: Logger }
): WebSocketServer {
  const { bus, log } = deps;
  const wss = new WebSocketServer({ noServer: true });
  wss.on('error', (error: Error) => {
    log.warn({ err: error }, 'internal event stream failed');
  });
  wss.on('connection', (socket: WebSocket) => {
    const unsubscribe = bus.subscribeStream(frame => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      // The send callback receives the failure, keeping it off the socket's `'error'` channel.
      socket.send(JSON.stringify(frame), error => {
        if (error) {
          unsubscribe();
        }
      });
    });
    socket.on('error', () => {
      unsubscribe();
      socket.terminate();
    });
    socket.on('close', () => {
      unsubscribe();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/internal/events') {
      wss.handleUpgrade(request, socket, head, upgraded => {
        wss.emit('connection', upgraded);
      });
    } else {
      socket.destroy();
    }
  });
  return wss;
}
