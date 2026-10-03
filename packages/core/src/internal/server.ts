/**
 * `core`'s internal HTTP+WS API on the Docker `internal` network (§3, §3.1): health, the
 * config-reload trigger and a live-state and event-stream surface for `api`. No authentication:
 * the internal network is the trust boundary.
 */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import {
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  isDbOpen,
  processStartedAtIso,
  resolveVersion,
  type CoreHealth,
  type CoreVersionResponse,
  type Db,
  type StateResponse
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { logFailure } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import type { CallActions } from '../calls/actions.js';
import type { Recorder } from '../calls/recording.js';
import type { Presence } from '../presence.js';
import { handleActionRoute, handleParkingRead } from './actionRoutes.js';
import {
  handleConfigChanged,
  respondJson,
  type PresenceRefresh,
  type TrunkMonitoringRefresh
} from './configChanged.js';
import { EventBus } from './eventBus.js';
import { handleMwiRoute } from './mwiRoute.js';
import { ConfigCache } from './snapshot.js';
import { StateStore } from './stateStore.js';

// When this process started, however late this module loads: `system.info` shows it (§10.3), so
// a restart is visible.
const processStartedAt = processStartedAtIso();

type InternalDeps = {
  db: Db;
  ari: AriClient;
  log: Logger;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  /** The live-call actions (§3). */
  actions: CallActions;
  /** Recomputed after every config change (`configChanged.ts`); its registrations give the
   * registered devices `/internal/state` serves (§7). */
  presence: PresenceRefresh & Pick<Presence, 'registeredDevices'>;
  /** The recordings in progress and the failed mixes `/internal/state` serves (§6.4, §10.2). */
  recorder: Pick<Recorder, 'inProgressCount' | 'mixFailureCount'>;
  /** The `unmonitored` trunk statuses, likewise. */
  trunks: TrunkMonitoringRefresh;
};

async function handleHealthz(
  deps: InternalDeps,
  response: http.ServerResponse
): Promise<void> {
  const ariConnected = deps.ari.connected;
  const dbOk = await isDbOpen(deps.db);
  const body: CoreHealth = {
    ok: dbOk && ariConnected,
    ari: ariConnected,
    db: dbOk
  };
  respondJson(response, body.ok ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE, body);
}

/**
 * `GET /internal/version` (§7 "Version"): what this `core` runs and since when, and when the
 * Asterisk it is connected to started, `null` while ARI is down or does not say; `api` reads the
 * latter each time its event stream (re)connects, to re-register the Ringotel apps after an
 * Asterisk restart it did not hear of (§10.4 "After a restart", `asteriskStarted.ts`).
 */
async function handleVersion(
  deps: InternalDeps,
  response: http.ServerResponse
): Promise<void> {
  const asteriskStartedAt = deps.ari.connected
    ? ((await deps.ari.asterisk
        .startupTime()
        .catch(logFailure(deps.log, 'Asterisk start time read'))) ?? null)
    : null;
  const body: CoreVersionResponse = {
    ...resolveVersion(process.env),
    startedAt: processStartedAt,
    asteriskStartedAt
  };
  respondJson(response, HTTP_OK, body);
}

/**
 * `GET /internal/state`: the live state, with the readings derived as it is served. §7
 * "registered devices" counts against the current config, so a device deleted while registered
 * drops out at once; §10.2 "Best effort": a failed mix "is visible in /metrics", which `api`
 * renders from here; §6.4 "Maintenance gate": `api` touches the running system only while the
 * recordings in progress and Asterisk's channels read zero, the latter `null` while ARI does not
 * answer.
 */
async function handleState(
  deps: InternalDeps,
  response: http.ServerResponse
): Promise<void> {
  const body: StateResponse = {
    ...deps.state.snapshot(),
    registeredDevices: await deps.presence.registeredDevices(),
    recordingMixFailures: deps.recorder.mixFailureCount,
    asteriskChannels: deps.ari.connected
      ? ((await deps.ari.channels
          .list()
          .then(channels => channels.length)
          .catch(logFailure(deps.log, 'Asterisk channel count'))) ?? null)
      : null,
    recordingsInProgress: deps.recorder.inProgressCount
  };
  respondJson(response, HTTP_OK, body);
}

async function routeRequest(
  deps: InternalDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://internal');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    await handleHealthz(deps, response);
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
    await handleVersion(deps, response);
    return;
  }
  if (
    request.method === 'GET' &&
    (await handleParkingRead(deps.actions, url.pathname, response))
  ) {
    return;
  }
  if (
    request.method === 'POST' &&
    ((await handleMwiRoute(deps, url.pathname, response)) ||
      (await handleActionRoute(deps.actions, url.pathname, request, response)))
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
  deps: Pick<InternalDeps, 'bus' | 'log'>
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

/**
 * Starts the internal HTTP+WS server: health, config reload, live state and the event stream.
 * Resolves with the port it bound, which differs from `port` only for `0` (any free port).
 */
export function startInternalServer(
  deps: InternalDeps,
  port: number
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    routeRequest(deps, request, response).catch((error: unknown) => {
      deps.log.error(
        { err: error, method: request.method, path: request.url },
        'internal API request failed'
      );
      respondJson(response, HTTP_SERVICE_UNAVAILABLE, {
        message: 'internal error'
      });
    });
  });
  const wss = attachEventStream(server, deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      resolve({
        port:
          address !== null && typeof address === 'object' ? address.port : port,
        close: () =>
          new Promise<void>(resolveClose => {
            // `server.close` waits for every socket to end, the event stream's upgraded ones too.
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close();
            server.close(() => {
              resolveClose();
            });
          })
      });
    });
  });
}
