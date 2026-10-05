/**
 * `api`'s process entry point (§10, §3.1): wraps the SvelteKit adapter-node build's request
 * handler in a plain HTTP server so a WebSocket can be attached for `/events` (§10.6). Every
 * event reaches those sockets from the SvelteKit bundle, where the background jobs run
 * (`lib/server/jobs/background.ts`), through the sink this file provides
 * (`lib/server/eventSink.ts`). It runs outside that bundle, where SvelteKit's `$app/env/private` does not
 * exist, so it reads `process.env` itself and passes what the modules it imports need, the
 * database file (`DB_FILE`, through shared's `dbFileFrom`) and `JWT_SECRET`, into them; none of
 * them reads the environment.
 */
import http from 'node:http';
import process from 'node:process';
import pino from 'pino';

import { dbFileFrom, openDb, resolveVersion } from '@zamfono/shared';

import { EventHub } from '#lib/server/events.js';
import { provideEventSink } from '#lib/server/eventSink.js';
import { attachEventsServer } from '#lib/server/eventsServer.js';

// A fixed internal port, never configurable per stack (§6.3 "Compose stack").
const API_INTERNAL_PORT = 3000;
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

async function main(): Promise<void> {
  // §7 "Version": the first line api logs, before anything that can fail boots.
  logger.info({ version: zamfonoVersion.display }, 'api starting');
  const db = openDb(dbFileFrom(process.env.DB_FILE));
  const hub = new EventHub(db);
  provideEventSink({
    publish: envelope => {
      hub.publish(envelope);
    },
    usersChanged: () => {
      hub.usersChanged().catch((error: unknown) => {
        logger.error({ err: error }, '/events user re-check failed');
      });
    }
  });
  const handler = await loadHandler();
  // After the handler, whose load validates `src/env.ts` and names every required variable missing.
  const jwtSecret = requireEnv('JWT_SECRET');
  const server = http.createServer(handler);
  attachEventsServer(server, { hub, db, jwtSecret });
  exitOnSignal(server);
  await new Promise<void>(resolve => {
    server.listen(API_INTERNAL_PORT, resolve);
  });
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- fatal boot failure, before any logger exists
  console.error('api failed to start', error);
  process.exit(1);
});
