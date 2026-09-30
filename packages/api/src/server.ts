/**
 * `api`'s process entry point (§10, §3.1): wraps the SvelteKit adapter-node build's request
 * handler in a plain HTTP server so a WebSocket can be attached for `/events` (§10.6). Every
 * event reaches those sockets from the SvelteKit bundle, where the background jobs run
 * (`lib/jobs/background.ts`), through the sink this file provides (`lib/eventSink.ts`).
 */
import http from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';

import { resolveVersion, type Db } from '@zamfono/shared';

import { getDb } from './lib/db.js';
import { EventHub } from './lib/events.js';
import { authenticateEventsSocket } from './lib/eventsAuth.js';
import { provideEventSink } from './lib/eventSink.js';
import { keyringFromEnv } from './lib/secretbox.js';

// Global Constraints "Fixed internal ports": api's port is never configurable per stack.
const API_INTERNAL_PORT = 3000;
const EVENTS_PATH = '/events';
const logger = pino({ name: 'server' });
// §7 "Version": read once at boot, since neither variable changes for the life of the process.
const zamfonoVersion = resolveVersion(process.env);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * The adapter-node build's request handler, loaded from a computed specifier so nothing needs
 * `handler.js` to exist while this file is authored or typechecked: `vite build` generates it as
 * a sibling of this file's own compiled output, `build/server.js` (`package.json`'s `build`
 * script), and it is absent until then. Loading it runs `hooks.server.ts`'s `init`: the
 * first-boot seed, the boot render and every background job, before it resolves; a failed seed
 * rejects it.
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
 * On SIGTERM or SIGINT: stops accepting connections, tells the SvelteKit bundle to stop its
 * jobs (`sveltekit:shutdown`, the event adapter-node's own server emits), and exits.
 */
function exitOnSignal(server: http.Server): void {
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'api stopping');
    server.close();
    process.emit('sveltekit:shutdown', signal);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export async function main(): Promise<void> {
  // §7 "Version": the first line api logs, before anything that can fail boots.
  logger.info({ version: zamfonoVersion.display }, 'api starting');
  const db = getDb();
  const jwtSecret = requireEnv('JWT_SECRET');
  // Fails the boot here, since the SvelteKit bundle only skips its jobs without a keyring.
  keyringFromEnv(process.env);
  const hub = new EventHub(db);
  provideEventSink(envelope => {
    hub.publish(envelope);
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
  exitOnSignal(server);
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
