import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunRequester, UpdateState } from '@zamfono/shared';

import type { ComposeProject } from './docker.js';
import { scriptEnv } from './stack.js';

const LOG_TAIL_LINES = 20;
const JSON_INDENT = 2;
/**
 * How long a run of `update.sh` on the host may stay `running` in the record before it counts as
 * cut off, its host stopped mid-run: well past its download, pull and three-minute health wait.
 */
export const HOST_RUN_STALE_MS = 3_600_000;

/**
 * One update at a time, run by the stack's own `update.sh` (§6.3 "Updates"), and its outcome
 * kept in the stack directory's `.update/`, so it outlives the updater and `system.info` reports
 * the last one after a restart. `update.sh` run on the host writes the same record of its own run.
 */
export type Runner = {
  /** The updater's own run while it runs, else `.update/state.json` as it is now. */
  current: () => UpdateState;
  /**
   * Starts `update.sh <to>`; the caller has checked that no update is running. Resolves once the
   * run is recorded as `running`, with `finished`, which resolves once its outcome is on disk.
   */
  start: (
    from: string,
    to: string,
    requester: RunRequester
  ) => Promise<{ finished: Promise<void> }>;
};

export type RunnerOptions = {
  stackDir: string;
  project: ComposeProject;
  socketPath: string;
  now?: () => string;
};

function isoNow(): string {
  return new Date().toISOString();
}

function stateFile(stackDir: string): string {
  return path.join(stackDir, '.update', 'state.json');
}

/**
 * Writes `state` in one rename, from a temporary file of this write's own: `update.sh` on the
 * host replaces the record through `state.json.next`, and two writes sharing that name could
 * rename each other's file away.
 */
async function persist(stackDir: string, state: UpdateState): Promise<void> {
  const file = stateFile(stackDir);
  const next = `${file}.${randomUUID()}.next`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(next, `${JSON.stringify(state, null, JSON_INDENT)}\n`);
  await rename(next, file);
}

/**
 * `state`, with a `running` run that cannot still be running marked failed: the updater's own,
 * since the updater never restarts itself, so a stop or a reboot of the host cut it off; or a run
 * of `update.sh` on the host started `HOST_RUN_STALE_MS` ago or longer, or at no recorded time. A
 * younger host run is left as it is: it recreates the updater while it runs, and writes its own
 * end once it ends.
 */
function settle(state: UpdateState, now: string): UpdateState {
  if (state.state !== 'running') {
    return state;
  }
  if (state.trigger === 'host') {
    if (
      state.startedAt !== undefined &&
      Date.parse(now) - Date.parse(state.startedAt) < HOST_RUN_STALE_MS
    ) {
      return state;
    }
    return {
      ...state,
      state: 'failed',
      finishedAt: now,
      error: 'interrupted: update.sh on the host did not finish the update'
    };
  }
  return {
    ...state,
    state: 'failed',
    finishedAt: now,
    error: 'interrupted: the updater stopped while the update ran'
  };
}

/** The state `.update/state.json` holds, `settle`d, and written back when that changed it. */
export async function loadState(
  stackDir: string,
  now: () => string = isoNow
): Promise<UpdateState> {
  let state: UpdateState = { state: 'idle' };
  try {
    state = JSON.parse(
      await readFile(stateFile(stackDir), 'utf8')
    ) as UpdateState;
  } catch {
    return state;
  }
  const settled = settle(state, now());
  if (settled !== state) {
    await persist(stackDir, settled);
  }
  return settled;
}

/**
 * `.update/state.json` as it is now, which `update.sh` run on the host may have written since the
 * updater last did, `settle`d without writing it back, or `fallback` while it cannot be read.
 */
function readState(
  stackDir: string,
  fallback: UpdateState,
  now: string
): UpdateState {
  try {
    return settle(
      JSON.parse(readFileSync(stateFile(stackDir), 'utf8')) as UpdateState,
      now
    );
  } catch {
    return fallback;
  }
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
    env: scriptEnv({
      COMPOSE_PROJECT_NAME: options.project.name,
      DOCKER_HOST: `unix://${options.socketPath}`
    }),
    stdio: ['ignore', logFd, logFd]
  });
}

export async function createRunner(options: RunnerOptions): Promise<Runner> {
  const now = options.now ?? isoNow;
  let state = await loadState(options.stackDir, now);
  const logFile = path.join(options.stackDir, '.update', 'update.log');
  const script = path.join(options.project.workingDir, 'update.sh');

  async function finish(
    code: number | null,
    run: Pick<UpdateState, 'by' | 'from' | 'to' | 'trigger'>,
    startedAt: string
  ): Promise<void> {
    const ok = code === 0;
    state = {
      state: ok ? 'succeeded' : 'failed',
      ...run,
      startedAt,
      finishedAt: now(),
      ...(ok
        ? {}
        : {
            error:
              (await logTail(logFile)) || `update.sh exited ${String(code)}`
          })
    };
    await persist(options.stackDir, state);
  }

  return {
    current: () =>
      state.state === 'running'
        ? state
        : readState(options.stackDir, state, now()),
    async start(from, to, requester) {
      const done = Promise.withResolvers<undefined>();
      const startedAt = now();
      const run = { from, to, ...requester };
      state = { state: 'running', ...run, startedAt };
      await persist(options.stackDir, state);
      const log = await open(logFile, 'w');
      const child = spawnUpdate(script, to, options, log.fd);
      let ended = false;
      // A child that fails to spawn emits 'error', and may or may not emit 'close' after it.
      const end = (code: number | null): void => {
        if (ended) {
          return;
        }
        ended = true;
        log
          .close()
          .then(async () => finish(code, run, startedAt))
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
      return { finished: done.promise };
    }
  };
}
