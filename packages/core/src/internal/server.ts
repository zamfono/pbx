/**
 * `core`'s internal HTTP+WS API on the Docker `internal` network (§3, §3.1): health, the
 * config-reload trigger and a live-state and event-stream surface for `api`. No authentication:
 * the internal network is the trust boundary.
 */
import http from 'node:http';
import { sql } from 'kysely';
import { WebSocket, WebSocketServer } from 'ws';

import {
  newId,
  nowIso,
  resolveVersion,
  type CoreHealth,
  type CoreVersionResponse,
  type Db,
  type Envelope,
  type Event,
  type HangupRequest,
  type OriginateRequest,
  type PickupRequest,
  type StateResponse,
  type TransferRequest
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { handleActionRoute } from './actionRoutes.js';
import {
  handleConfigChanged,
  respondJson,
  type PresenceRefresh
} from './configChanged.js';
import { ConfigCache, type Snapshot } from './snapshot.js';
import { StateStore } from './stateStore.js';

export { ConfigCache, StateStore };
export type { Snapshot };

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MS_PER_SECOND = 1000;

// When this process started, however late this module loads: `system.info` shows it (§10.3), so
// a restart is visible.
const processStartedAt = new Date(
  Date.now() - process.uptime() * MS_PER_SECOND
).toISOString();

/** The live-call actions (§3), `calls/actions.ts`'s `CallActions`; `null` leaves their routes 404. */
export type CallActions = {
  originate: (
    req: OriginateRequest
  ) => Promise<{ callId: string } | { error: 'noRegisteredDevice' }>;
  transfer: (callId: string, req: TransferRequest) => Promise<void>;
  pickup: (callId: string, req: PickupRequest) => Promise<void>;
  hangup: (callId: string, req: HangupRequest) => Promise<void>;
};

type InternalDeps = {
  db: Db;
  ari: AriClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  actions: CallActions | null;
  /** Recomputed after every config change (`configChanged.ts`); `null` leaves presence alone. */
  presence: PresenceRefresh | null;
};

/** Wraps every core-produced `Event` into an `Envelope` and fans it out to subscribers. */
export class EventBus {
  private readonly subscribers = new Set<(envelope: Envelope) => void>();

  emit(event: Event): Envelope {
    const envelope: Envelope = { ...event, id: newId(), at: nowIso() };
    for (const subscriber of this.subscribers) {
      subscriber(envelope);
    }
    return envelope;
  }

  subscribe(fn: (envelope: Envelope) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}

async function isDbHealthy(db: Db): Promise<boolean> {
  try {
    await sql`select 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

async function handleHealthz(
  deps: InternalDeps,
  ariConnected: boolean,
  response: http.ServerResponse
): Promise<void> {
  const dbOk = await isDbHealthy(deps.db);
  const body: CoreHealth = {
    ok: dbOk && ariConnected,
    ari: ariConnected,
    db: dbOk
  };
  respondJson(response, body.ok ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE, body);
}

/**
 * `GET /internal/version` (§7 "Version"): what this `core` runs and since when, and when the
 * Asterisk it is connected to started, `null` while ARI is down or does not say; `api` watches the
 * latter to re-register the Ringotel apps after an Asterisk restart (§10.4 "After a restart").
 */
async function handleVersion(
  deps: InternalDeps,
  ariConnected: boolean,
  response: http.ServerResponse
): Promise<void> {
  const asteriskStartedAt = ariConnected
    ? await deps.ari.asterisk.startupTime().catch(() => null)
    : null;
  const body: CoreVersionResponse = {
    ...resolveVersion(process.env),
    startedAt: processStartedAt,
    asteriskStartedAt
  };
  respondJson(response, HTTP_OK, body);
}

async function handleState(
  deps: InternalDeps,
  response: http.ServerResponse
): Promise<void> {
  const body: StateResponse = await deps.state.snapshot();
  respondJson(response, HTTP_OK, body);
}

async function routeRequest(
  deps: InternalDeps,
  isAriConnected: () => boolean,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://internal');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    await handleHealthz(deps, isAriConnected(), response);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/internal/configChanged') {
    await handleConfigChanged(deps, request, response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/internal/state') {
    await handleState(deps, response);
    return;
  }
  // The version this `core` runs (§7 "Version"), for `api`'s `system.info`: during an upgrade, or
  // with one container left on an old image, it can differ from `api`'s own.
  if (request.method === 'GET' && url.pathname === '/internal/version') {
    await handleVersion(deps, isAriConnected(), response);
    return;
  }
  if (
    request.method === 'POST' &&
    (await handleActionRoute(deps, url.pathname, request, response))
  ) {
    return;
  }
  respondJson(response, HTTP_NOT_FOUND, { message: 'not found' });
}

/**
 * `ws` reports a receiver protocol violation or a broken pipe as an `'error'` event, which Node
 * throws when no listener is attached; the server, every accepted socket and every send carry
 * one, so a single bad frame or peer never takes core's Stasis app down with it (§3.1
 * "Independence").
 */
function attachEventStream(
  server: http.Server,
  bus: EventBus
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  // ponytail: no logger is wired into this module; add one if these need investigating.
  wss.on('error', () => undefined);
  wss.on('connection', (socket: WebSocket) => {
    const unsubscribe = bus.subscribe(envelope => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      // The send callback receives the failure, keeping it off the socket's `'error'` channel.
      socket.send(JSON.stringify(envelope), error => {
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

/**
 * Starts the internal HTTP+WS server: health, config reload, live state and the event stream.
 * Resolves with the port it bound, which differs from `port` only for `0` (any free port).
 */
export function startInternalServer(
  deps: InternalDeps,
  port: number
): Promise<{ port: number; close: () => Promise<void> }> {
  // ARI exposes no direct connection getter, only `'connected'`/`'disconnected'` events, and by
  // the boot order (§3.1) it is already connected by the time this server starts.
  let ariConnected = true;
  deps.ari.on('connected', () => {
    ariConnected = true;
  });
  deps.ari.on('disconnected', () => {
    ariConnected = false;
  });
  const server = http.createServer((request, response) => {
    routeRequest(deps, () => ariConnected, request, response).catch(() => {
      respondJson(response, HTTP_SERVICE_UNAVAILABLE, {
        message: 'internal error'
      });
    });
  });
  const wss = attachEventStream(server, deps.bus);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      resolve({
        port:
          address !== null && typeof address === 'object' ? address.port : port,
        close: () =>
          new Promise<void>(resolveClose => {
            wss.close();
            server.close(() => {
              resolveClose();
            });
          })
      });
    });
  });
}
