/**
 * `api`'s process entry point (§10, §3.1): wraps the SvelteKit adapter-node build's request
 * handler in a plain HTTP server so a WebSocket can be attached for `/events` (§10.6), and
 * relays `core`'s event stream to `/events` subscribers and webhooks (§3.1 "Events").
 */
import { execFile } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pino from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';

import { resolveVersion, type Db } from '@zamfono/shared';

import { connectCoreEvents } from './lib/coreEvents.js';
import { getDb } from './lib/db.js';
import { EventHub } from './lib/events.js';
import { authenticateEventsSocket } from './lib/eventsAuth.js';
import type { Bus, ExecFn } from './lib/jobs/backup.js';
import { scheduleBackups } from './lib/jobs/cron.js';
import { scheduleRetention } from './lib/jobs/retention.js';
import { propagateAtBoot } from './lib/propagation.js';
import { keyringFromEnv, type Keyring } from './lib/secretbox.js';
import { seedIfEmpty } from './lib/seed.js';
import { WebhookDispatcher } from './lib/webhooks.js';

// Global Constraints "Fixed internal ports": api's port is never configurable per stack.
const API_INTERNAL_PORT = 3000;
const EVENTS_PATH = '/events';
const DEFAULT_MEDIA_DIR = '/media';
const logger = pino({ name: 'server' });
// §7 "Version": read once at boot, since neither variable changes for the life of the process.
const zamfonoVersion = resolveVersion(process.env);
const execFileAsync = promisify(execFile);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

/** The shared media volume root (`MEDIA_DIR`, `images/api/Dockerfile`), read at call time so tests can override it. */
function mediaDirFromEnv(): string {
  return process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR;
}

/**
 * Production `ExecFn` for `scheduleBackups` (Task 40 `backup.ts`/`backupBackends.ts`): runs
 * `file`, writing `options.input` to stdin when given — `rclone obscure`'s only way to take a
 * credential off argv. `execFileAsync`'s returned promise carries the spawned `ChildProcess` as
 * `.child` (Node's own `promisify(execFile)` contract), so its stdin is reachable without a
 * hand-rolled `child_process` wrapper.
 */
export const execCommand: ExecFn = (file, args, options) => {
  const result = execFileAsync(file, args, { env: options.env });
  if (options.input !== undefined) {
    result.child.stdin?.end(options.input);
  }
  return result;
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** `CORE_URL` (`http://core:3000`, §6.3) as the internal event stream's `ws://` URL. */
function coreEventsUrl(coreUrl: string): string {
  return `${coreUrl.replace(/^http/u, 'ws')}/internal/events`;
}

/**
 * The adapter-node build's request handler, loaded from a computed specifier so nothing needs
 * `handler.js` to exist while this file is authored or typechecked: `vite build` generates it as
 * a sibling of this file's own compiled output, `build/server.js` (`package.json`'s `build`
 * script), and it is absent until then.
 */
async function loadHandler(): Promise<Handler> {
  const handlerUrl = new URL('./handler.js', import.meta.url).href;
  const built = (await import(handlerUrl)) as { handler: Handler };
  return built.handler;
}

/** Runs the `/events` auth handshake on an upgraded socket, then registers it with `hub`. */
async function acceptEventsSocket(
  hub: EventHub,
  socket: WebSocket,
  deps: { db: Db; jwtSecret: string }
): Promise<void> {
  try {
    const actor = await authenticateEventsSocket(socket, deps);
    if (actor) {
      await hub.subscribeWs(socket, actor);
    }
  } catch (error) {
    logger.error({ error }, '/events socket setup failed');
    socket.terminate();
  }
}

/**
 * First boot and the background jobs this bundle owns (§6.3 "First boot", §6.5 backups, §5.9 the
 * daily purge). The seed runs to completion first and its failure propagates, so the process never
 * reaches `server.listen` on a database without an owner, a settings row or its parking slots.
 * The Asterisk configuration is then rendered from that database (§3.1, §9.1), before `api`
 * reports healthy and so before `core` starts and reloads it.
 */
export async function startBootJobs(
  db: Db,
  kr: Keyring,
  bus: Bus
): Promise<void> {
  const mediaDir = mediaDirFromEnv();
  const seeded = await seedIfEmpty(db, process.env, kr, mediaDir, logger);
  logger.info({ seeded }, 'boot: first-boot seed');
  await propagateAtBoot(db, logger);
  scheduleBackups(db, kr, { exec: execCommand, mediaDir, bus });
  scheduleRetention(db);
}

export async function main(): Promise<void> {
  // §7 "Version": the first line api logs, before anything that can fail boots.
  logger.info({ version: zamfonoVersion.display }, 'api starting');
  const db = getDb();
  const jwtSecret = requireEnv('JWT_SECRET');
  const kr = keyringFromEnv(process.env);
  const hub = new EventHub(db);
  const dispatcher = new WebhookDispatcher({ db, kr });
  // Config propagation (§3.1), the daily certificate sync (§6.4) and the key-rotation sweep
  // (§5.4) are wired from `hooks.server.ts`, the module instance SvelteKit builds for
  // `runOperation` and the routes; this file is a separate esbuild bundle with its own copy of
  // every relative import.
  const bus: Bus = {
    publish: envelope => {
      hub.publish(envelope);
    },
    enqueue: envelope => dispatcher.enqueue(envelope)
  };
  await startBootJobs(db, kr, bus);
  connectCoreEvents({
    url: coreEventsUrl(requireEnv('CORE_URL')),
    onEvent: envelope => {
      hub.publish(envelope);
      dispatcher.enqueue(envelope).catch((error: unknown) => {
        logger.error(
          { error, eventId: envelope.id },
          'webhook delivery failed'
        );
      });
    }
  });
  const handler = await loadHandler();
  const server = http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true });
  wss.on('error', (error: unknown) => {
    logger.error({ error }, '/events WebSocket server error');
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== EVENTS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      acceptEventsSocket(hub, ws, { db, jwtSecret }).catch((error: unknown) => {
        logger.error({ error }, '/events socket accept failed');
      });
    });
  });
  await new Promise<void>(resolve => {
    server.listen(API_INTERNAL_PORT, resolve);
  });
}

// Only run on direct execution (`node server.js`), not when imported by a test.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- fatal boot failure, before any logger exists
    console.error('api failed to start', error);
    process.exit(1);
  });
}
