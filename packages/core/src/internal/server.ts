/**
 * `core`'s internal HTTP+WS API on the Docker `internal` network (§3, §3.1): health, readiness, the
 * config-reload trigger and a live-state and event-stream surface for `api`. No authentication:
 * the internal network is the trust boundary.
 */
import http from 'node:http';

import {
  HEALTH_CONTENT_TYPE,
  healthDocument,
  healthHttpStatus,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  isDbOpen,
  processStartedAtIso,
  type CoreVersionResponse,
  type Db,
  type HealthCheck,
  type HealthChecks,
  type StateResponse,
  type ZamfonoVersion
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
  type PresenceRefresh,
  type TrunkMonitoringRefresh
} from './configChanged.js';
import { EventBus } from './eventBus.js';
import { attachEventStream } from './eventStream.js';
import { respondJson, respondProblem } from './http.js';
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
  /** The version `/internal/version` reports (§7 "Version"), `CoreEnv.version`. */
  version: ZamfonoVersion;
};

/** `core:database` and `core:ari`, each `fail` while down (§6.3 "Health"). */
async function healthChecks(deps: InternalDeps): Promise<HealthChecks> {
  const passOrFail = (up: boolean): [HealthCheck] => [
    { status: up ? 'pass' : 'fail' }
  ];
  return {
    'core:database': passOrFail(await isDbOpen(deps.db)),
    'core:ari': passOrFail(deps.ari.connected)
  };
}

/** `GET /healthz`: the health document whose checks `api` copies into its own (§6.3 "Health"). */
async function handleHealthz(
  deps: InternalDeps,
  response: http.ServerResponse
): Promise<void> {
  const document = healthDocument(await healthChecks(deps));
  response.writeHead(healthHttpStatus(document), {
    'Content-Type': HEALTH_CONTENT_TYPE,
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(document));
}

/** `GET /readyz`, the compose healthcheck's: 200 with an empty body while the database is open
 * and ARI connected, else 503 (§6.3 "Health"). */
async function handleReadyz(
  deps: InternalDeps,
  response: http.ServerResponse
): Promise<void> {
  const ready = healthDocument(await healthChecks(deps)).status === 'pass';
  response.writeHead(ready ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE);
  response.end();
}

/**
 * `GET /internal/version` (§7 "Version"): what this `core` runs and since when, and when the
 * Asterisk it is connected to started, `null` while ARI is down or does not say; `api` reads the
 * latter each time its event stream (re)connects, to re-register the Ringotel apps after an
 * Asterisk restart it did not hear of (§10.4 "After a restart", `asteriskStarted.ts`). During an
 * upgrade, or with one container left on an old image, it can differ from `api`'s own.
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
    ...deps.version,
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

/** Serves the request when `pathname` names this route; `null` when it names another. */
type Route = (
  deps: InternalDeps,
  pathname: string,
  response: http.ServerResponse,
  request: http.IncomingMessage
) => Promise<void> | null;

/** The route on the one path `path`. */
function at(
  path: string,
  serve: (
    deps: InternalDeps,
    response: http.ServerResponse,
    request: http.IncomingMessage
  ) => Promise<void>
): Route {
  return (deps, pathname, response, request) =>
    pathname === path ? serve(deps, response, request) : null;
}

const ROUTES: Partial<Record<string, Route[]>> = {
  GET: [
    at('/healthz', handleHealthz),
    at('/readyz', handleReadyz),
    at('/internal/state', handleState),
    at('/internal/version', handleVersion),
    at('/internal/parking', handleParkingRead)
  ],
  POST: [
    at('/internal/configChanged', handleConfigChanged),
    handleMwiRoute,
    handleActionRoute
  ]
};

function routeRequest(
  deps: InternalDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const { pathname } = new URL(request.url ?? '/', 'http://internal');
  for (const route of ROUTES[request.method ?? ''] ?? []) {
    const served = route(deps, pathname, response, request);
    if (served !== null) {
      return served;
    }
  }
  respondProblem(response, HTTP_NOT_FOUND, 'not found');
  return Promise.resolve();
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
      respondProblem(response, HTTP_SERVICE_UNAVAILABLE, 'internal error');
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
