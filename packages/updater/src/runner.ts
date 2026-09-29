import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ComposeProject } from './docker.js';

/**
 * One update at a time, run by the stack's own `update.sh` (§6.3 "Updates"), and its outcome
 * kept in the stack directory's `.update/`, so it outlives the updater and `system.info` reports
 * the last one after a restart.
 */
export type UpdateState = {
  state: 'idle' | 'running' | 'succeeded' | 'failed';
  from?: string;
  to?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

const LOG_TAIL_LINES = 20;
const JSON_INDENT = 2;

export type Runner = {
  current: () => UpdateState;
  /** Starts `update.sh <to>`; the caller has checked that no update is running. */
  start: (from: string, to: string) => Promise<void>;
  /** Resolves once the running update, if any, has ended; for tests. */
  settled: () => Promise<void>;
};

export type RunnerOptions = {
  stackDir: string;
  project: ComposeProject;
  socketPath: string;
  /** The script to run; `update.sh` in the project's own directory unless a test says otherwise. */
  script?: string;
  now?: () => string;
};

function stateFile(stackDir: string): string {
  return path.join(stackDir, '.update', 'state.json');
}

async function persist(stackDir: string, state: UpdateState): Promise<void> {
  const file = stateFile(stackDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    `${file}.next`,
    `${JSON.stringify(state, null, JSON_INDENT)}\n`
  );
  await rename(`${file}.next`, file);
}

/**
 * The state `.update/state.json` holds, with a run still `running` there marked failed: the
 * updater never restarts itself, so such a run was cut off by a stop or a reboot of the host.
 */
export async function loadState(
  stackDir: string,
  now: () => string = () => new Date().toISOString()
): Promise<UpdateState> {
  let state: UpdateState = { state: 'idle' };
  try {
    state = JSON.parse(
      await readFile(stateFile(stackDir), 'utf8')
    ) as UpdateState;
  } catch {
    return state;
  }
  if (state.state === 'running') {
    state = {
      ...state,
      state: 'failed',
      finishedAt: now(),
      error: 'interrupted: the updater stopped while the update ran'
    };
    await persist(stackDir, state);
  }
  return state;
}

async function logTail(logFile: string): Promise<string> {
  try {
    const lines = (await readFile(logFile, 'utf8')).trimEnd().split('\n');
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
}

/** `update.sh <to>` in the project's directory, as the updater's run (`ZAMFONO_UPDATER=1`). */
function spawnUpdate(
  script: string,
  to: string,
  options: RunnerOptions,
  logFd: number
): ChildProcess {
  return spawn('bash', [script, to], {
    // The host's path, which main.ts links to the mounted stack directory: Compose resolves the
    // files' relative paths (./Caddyfile) against it, and the runtime reads them there.
    cwd: options.project.workingDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ZAMFONO_UPDATER: '1',
      ZAMFONO_COMPOSE_FILES: options.project.configFiles.join(' '),
      COMPOSE_PROJECT_NAME: options.project.name,
      DOCKER_HOST: `unix://${options.socketPath}`
    },
    stdio: ['ignore', logFd, logFd]
  });
}

export async function createRunner(options: RunnerOptions): Promise<Runner> {
  const now = options.now ?? (() => new Date().toISOString());
  const holder: { state: UpdateState; done: Promise<void> } = {
    state: await loadState(options.stackDir, now),
    done: Promise.resolve()
  };
  const logFile = path.join(options.stackDir, '.update', 'update.log');
  const script =
    options.script ?? path.join(options.project.workingDir, 'update.sh');

  async function finish(
    code: number | null,
    from: string,
    to: string,
    startedAt: string
  ): Promise<void> {
    const ok = code === 0;
    holder.state = {
      state: ok ? 'succeeded' : 'failed',
      from,
      to,
      startedAt,
      finishedAt: now(),
      ...(ok
        ? {}
        : {
            error:
              (await logTail(logFile)) || `update.sh exited ${String(code)}`
          })
    };
    await persist(options.stackDir, holder.state);
  }

  return {
    current: () => holder.state,
    settled: async () => holder.done,
    async start(from, to) {
      // Settled when the run has ended and its outcome is on disk; set before the first await,
      // so `settled()` never returns a previous run's.
      const done = Promise.withResolvers<undefined>();
      holder.done = done.promise;
      const startedAt = now();
      holder.state = { state: 'running', from, to, startedAt };
      await persist(options.stackDir, holder.state);
      const log = await open(logFile, 'w');
      const child = spawnUpdate(script, to, options, log.fd);
      const ended = { once: false };
      // A child that fails to spawn emits 'error', and may or may not emit 'close' after it.
      const end = (code: number | null): void => {
        if (ended.once) {
          return;
        }
        ended.once = true;
        log
          .close()
          .then(async () => finish(code, from, to, startedAt))
          .then(
            () => {
              done.resolve(undefined);
            },
            () => {
              done.resolve(undefined);
            }
          );
      };
      child.once('error', end.bind(undefined, null));
      child.once('close', end);
    }
  };
}
