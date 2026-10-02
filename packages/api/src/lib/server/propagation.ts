/**
 * Config propagation (§3.1 "Config propagation", §9.1): assembles a `RenderInput` from the
 * database, writes the four rendered files atomically onto the `asterisk-config` volume, and
 * asks `core` to reload the Asterisk modules the caller names.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';
import pino, { type Logger } from 'pino';

import type { Db, ReloadKind } from '@zamfono/shared';

import { getCoreClient } from './coreClient.js';
import { recordConfigPropagationFailure } from './metrics.js';
import { runWaitingHooks } from './ops/afterCommit.js';
import { render } from './pjsip/render.js';
import {
  isPropagationPending,
  setPropagationPending
} from './propagationPending.js';
import { loadRenderInput } from './renderInput.js';
import { keyringFromEnv } from './secretbox.js';

const DEFAULT_ASTERISK_GEN_DIR = '/etc/asterisk/gen';
// Every module the render feeds (§9.1): PJSIP, the dialplan's hints include, `res_musiconhold`.
const ALL_RELOAD_KINDS: ReloadKind[] = ['pjsip', 'dialplan', 'moh'];
// The retry of an owed propagation (§3.1): 5 s after the failure, doubling up to a minute.
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const RETRY_BACKOFF_FACTOR = 2;

const log = pino({ name: 'propagation' });

/** `ASTERISK_GEN_DIR` (§6.3, fixed image path `/etc/asterisk/gen`). */
export function asteriskGenDirFromEnv(): string {
  return env.ASTERISK_GEN_DIR ?? DEFAULT_ASTERISK_GEN_DIR;
}

/** Writes `contents` to `filePath` via a same-directory temp file and `rename`, which POSIX and NTFS both make an atomic replace: a reader of `filePath` never observes a partial write. `mode`, when given, is the temp file's permission bits (e.g. a private key kept unreadable by other users of the shared volume). */
export async function writeFileAtomically(
  filePath: string,
  contents: string | Buffer,
  mode?: number
): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, contents, mode === undefined ? undefined : { mode });
  await rename(tmpPath, filePath);
}

// The tail of the propagation chain: one render-and-reload at a time (`serialized`).
let chainTail: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` once every propagation started before it has settled, whatever its outcome. Two
 * writes propagating side by side could otherwise render in one order and write the files in the
 * other: the older render, read before the newer write committed, would land last, and both
 * reloads would load it, leaving that write out of Asterisk until the next one (§3.1, §9.1).
 */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = chainTail.then(task, task);
  chainTail = run.catch(() => undefined);
  return run;
}

/**
 * Renders the PJSIP/hints/MoH configuration from the live database onto the `asterisk-config`
 * volume (§9.1). All four files are rewritten together, since a partial rewrite could leave them
 * inconsistent with each other.
 */
async function renderConfig(db: Db): Promise<void> {
  const input = await loadRenderInput(db, keyringFromEnv(env));
  const rendered = render(input);
  const dir = asteriskGenDirFromEnv();
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(rendered).map(([filename, contents]) =>
      writeFileAtomically(path.join(dir, filename), contents)
    )
  );
}

let retryTimer: NodeJS.Timeout | undefined;
let retryDelayMs = RETRY_FIRST_MS;

/**
 * Tries the owed propagation again once the backoff has passed, then runs what waited for it.
 * One timer at a time; a success in between, a write's included, cancels it.
 */
function scheduleRetry(db: Db): void {
  if (retryTimer !== undefined) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    retryDelayMs = Math.min(retryDelayMs * RETRY_BACKOFF_FACTOR, RETRY_MAX_MS);
    // eslint-disable-next-line no-use-before-define -- the retry is a propagation, and a failed propagation schedules the retry
    propagateConfig(db, []).then(
      async () => runWaitingHooks(db),
      (error: unknown) => {
        log.warn({ error }, 'the owed config propagation failed again');
      }
    );
  }, retryDelayMs);
  retryTimer.unref();
}

/** Marks a propagation owed after it failed, counts the failure and schedules its retry. */
async function owe(db: Db): Promise<void> {
  recordConfigPropagationFailure();
  await setPropagationPending(db, true);
  scheduleRetry(db);
}

/** Clears what a succeeded propagation no longer owes: the marker and the retry. */
async function settle(db: Db): Promise<void> {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelayMs = RETRY_FIRST_MS;
  await setPropagationPending(db, false);
}

/**
 * Tells `core` that configuration it reads has changed, so it drops its config cache (§3.1
 * "Config propagation"). Where `kinds` names Asterisk modules, the configuration is rendered
 * first (`renderConfig`) and `core` reloads those modules; a write that changes nothing Asterisk
 * holds only invalidates the cache. While a propagation is owed, every module is rendered and
 * reloaded, which settles it; a failure leaves one owed and retried. Propagations run one at a
 * time (`serialized`).
 */
export async function propagateConfig(
  db: Db,
  kinds: ReloadKind[]
): Promise<void> {
  await serialized(async () => {
    const pending = await isPropagationPending(db);
    const reload = pending ? ALL_RELOAD_KINDS : kinds;
    try {
      if (reload.length > 0) {
        await renderConfig(db);
      }
      await getCoreClient().configChanged(reload);
    } catch (error) {
      await owe(db);
      throw error;
    }
    if (pending) {
      await settle(db);
    }
  });
}

/**
 * The boot-time propagation (§3.1, §9.1), run once after the first-boot seed and before `api`
 * serves: the volume holds nothing a fresh stack's seed wrote (the parking-slot hints, the hold
 * music classes, §6.3 "First boot") and, after an upgrade, the previous release's render, until
 * something renders the database again. A render failure is logged and owed rather than thrown,
 * so `api` still serves and retries it. `core` starts only once `api` is healthy (§6.3) and
 * reloads every rendered module at its own boot, so on a fresh start its refusal here is
 * expected and owes nothing; a propagation owed from before the restart stays owed until `core`
 * takes one.
 */
export async function propagateAtBoot(db: Db, bootLog: Logger): Promise<void> {
  await serialized(async () => {
    try {
      await renderConfig(db);
    } catch (error) {
      bootLog.error({ error }, 'boot: config render failed');
      await owe(db);
      return;
    }
    try {
      await getCoreClient().configChanged(ALL_RELOAD_KINDS);
    } catch (error) {
      bootLog.info(
        { error },
        'boot: core not reachable; it reloads the rendered config at its own start'
      );
      if (await isPropagationPending(db)) {
        scheduleRetry(db);
      }
      return;
    }
    await settle(db);
  });
}
