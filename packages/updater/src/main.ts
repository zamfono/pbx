import process from 'node:process';

import { createAgent } from './agent.js';
import { createReleases } from './releases.js';
import { createServer } from './server.js';
import { checkUpdate, stackVersion } from './stack.js';
import { stopOnSignal } from './stop.js';

/**
 * The updater service (§6.3 "Updates"): the stack directory is mounted read-only at `/stack`,
 * but for `.update/requests`, where it leaves its requests to the host agent. It holds no
 * container runtime socket and nothing else of the host.
 */
const STACK_DIR = '/stack';
/** The internal port `api` reaches the updater on. */
const PORT = 8080;

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), msg: message, ...fields })}\n`
  );
}

// Compose hands an unset UPDATER_TOKEN over empty, which counts as unset.
const token =
  process.env.UPDATER_TOKEN === '' ? undefined : process.env.UPDATER_TOKEN;
if (token === undefined) {
  log('UPDATER_TOKEN is not set: every request is refused');
}
const server = createServer({
  token,
  releases: createReleases(),
  currentVersion: async () => stackVersion(STACK_DIR),
  checkUpdate: async version => checkUpdate(STACK_DIR, version),
  agent: createAgent(STACK_DIR),
  hostControl: process.env.HOST_CONTROL === 'true'
}).listen(PORT);
log('updater ready');
stopOnSignal(server, log);
