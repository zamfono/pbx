import { mkdir, readlink, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inspectProject, type ComposeProject } from './docker.js';
import { errorMessage } from './errors.js';
import { createReleases } from './releases.js';
import { createRunner, type Runner } from './runner.js';
import { createServer } from './server.js';
import { checkUpdate, stackVersion } from './stack.js';

/**
 * The updater service (§6.3 "Updates"): the stack directory is mounted at `/stack`, the
 * runtime's socket at `/var/run/docker.sock`. It links the host's path of the stack directory to
 * `/stack` inside the container, so the `docker compose` that `update.sh` runs resolves every
 * file where the runtime, on the host, will look for it.
 */
const STACK_DIR = '/stack';
const SOCKET = '/var/run/docker.sock';
/** The internal port `api` reaches the updater on. */
const PORT = 8080;

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), msg: message, ...fields })}\n`
  );
}

async function linkHostPath(project: ComposeProject): Promise<void> {
  if (project.workingDir === STACK_DIR) {
    return;
  }
  const existing = await readlink(project.workingDir).catch(() => undefined);
  if (existing === STACK_DIR) {
    return;
  }
  await mkdir(path.dirname(project.workingDir), { recursive: true });
  await symlink(STACK_DIR, project.workingDir);
}

/**
 * Compose creates a bind mount's missing source as an empty directory, so a `CONTAINER_SOCKET`
 * that names no socket still starts the stack, with an updater that says what to set.
 */
async function assertSocket(): Promise<void> {
  const isSocket = await stat(SOCKET).then(
    info => info.isSocket(),
    () => false
  );
  if (!isSocket) {
    throw new Error(
      'no container runtime socket is mounted: set CONTAINER_SOCKET in .env (Docker: /var/run/docker.sock, Podman: /run/podman/podman.sock) and run up -d'
    );
  }
}

async function prepare(): Promise<{ runner?: Runner; unavailable?: string }> {
  try {
    await assertSocket();
    // A container's host name is its id's first 12 characters, on Docker and on Podman alike.
    const project = await inspectProject(SOCKET, os.hostname());
    await linkHostPath(project);
    log('updater ready', {
      project: project.name,
      workingDir: project.workingDir
    });
    return {
      runner: await createRunner({
        stackDir: STACK_DIR,
        project,
        socketPath: SOCKET
      })
    };
  } catch (error) {
    const unavailable = errorMessage(error);
    log('updater cannot update', { error: unavailable });
    return { unavailable };
  }
}

const { runner, unavailable } = await prepare();
// Compose hands an unset UPDATER_TOKEN over empty, which counts as unset.
const token =
  process.env.UPDATER_TOKEN === '' ? undefined : process.env.UPDATER_TOKEN;
if (token === undefined) {
  log('UPDATER_TOKEN is not set: every request is refused');
}
createServer({
  token,
  releases: createReleases(),
  currentVersion: async () => stackVersion(STACK_DIR),
  checkUpdate: async version => checkUpdate(STACK_DIR, version),
  runner,
  ...(unavailable === undefined ? {} : { unavailable })
}).listen(PORT);
