// FakeAri's transport: an HTTP server on a loopback port for the REST calls and the `/ari/events`
// WebSocket the client subscribes to. What a request does is the fake's model's business.
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

import { parseBody, sendResult, type RouteResult } from './fakeHttp.js';

/** One frame of the events stream as the fake sends it: any fields, so a test can send an event
 * with only the fields it is about, or one core does not know. */
export type AriFrame = { type: string; [key: string]: unknown };

/** One REST request, its path relative to `/ari/` and its raw query string (`''` when absent). */
export type FakeRequest = {
  method: string;
  path: string;
  qs: string;
  body: unknown;
};

/** How long a request is held before it is handled: that many ms, or until the promise settles. */
export type RequestHold = number | Promise<void>;

export class FakeAriTransport {
  private readonly handle: (request: FakeRequest) => RouteResult;
  private readonly holdFor: (request: FakeRequest) => RequestHold;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;

  /** `holdFor` holds a request before it is handled, as a slow connection would. */
  constructor(
    handle: (request: FakeRequest) => RouteResult,
    holdFor: (request: FakeRequest) => RequestHold = () => 0
  ) {
    this.handle = handle;
    this.holdFor = holdFor;
  }

  listen(): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        this.handleRequest(request, response);
      });
      const wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (socket: WebSocket) => {
        this.client = socket;
        socket.on('close', () => {
          if (this.client === socket) {
            this.client = null;
          }
        });
      });
      server.on('upgrade', (request, socket, head) => {
        if (request.url?.startsWith('/ari/events') === true) {
          wss.handleUpgrade(request, socket, head, upgraded => {
            wss.emit('connection', upgraded);
          });
        } else {
          socket.destroy();
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('FakeAri failed to bind to a port'));
          return;
        }
        this.server = server;
        this.wss = wss;
        resolve({ url: `http://127.0.0.1:${address.port}/ari` });
      });
    });
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.wss?.close();
      this.client?.terminate();
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Drops the connected client's socket, so a reconnect can be observed. */
  disconnectClient(): void {
    this.client?.terminate();
  }

  /** Sends `event` to the connected client; dropped when none is connected, as Asterisk does. */
  send(event: AriFrame): void {
    this.client?.send(JSON.stringify(event));
  }

  private handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const method = request.method ?? 'GET';
      const pathAndQuery = (request.url ?? '/').replace(/^\/ari\//u, '');
      const [path = '', qs = ''] = pathAndQuery.split('?');
      const fakeRequest = { method, path, qs, body: parseBody(chunks) };
      const hold = this.holdFor(fakeRequest);
      const respond = (): void => {
        sendResult(response, this.handle(fakeRequest));
      };
      if (typeof hold !== 'number') {
        hold.then(respond, respond);
      } else if (hold <= 0) {
        respond();
      } else {
        setTimeout(respond, hold);
      }
    });
  }
}
