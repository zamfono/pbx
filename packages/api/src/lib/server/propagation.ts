/**
 * Config propagation (§3.1 "Config propagation", §9.1): assembles a `RenderInput` from the
 * database, writes the four rendered files atomically onto the `asterisk-config` volume, and
 * asks `core` to reload the Asterisk modules the caller names.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';
import type { Logger } from 'pino';

import type { Db, ReloadKind } from '@zamfono/shared';

import { createCoreClient, type CoreClient } from './coreClient.js';
import { render } from './pjsip/render.js';
import { loadRenderInput } from './renderInput.js';
import { keyringFromEnv, type Keyring } from './secretbox.js';

const DEFAULT_ASTERISK_GEN_DIR = '/etc/asterisk/gen';
// Every module the render feeds (§9.1): PJSIP, the dialplan's hints include, `res_musiconhold`.
const ALL_RELOAD_KINDS: ReloadKind[] = ['pjsip', 'dialplan', 'moh'];

/** `ASTERISK_GEN_DIR` (§6.3, fixed image path `/etc/asterisk/gen`), read at call time for tests. */
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

export type PropagationDeps = {
  kr: Keyring;
  coreClient: CoreClient;
  genDir?: string;
};

const defaultDepsCache: { deps?: PropagationDeps } = {};

/** `PropagationDeps` resolved from the environment, cached like `getDb()`, for the `propagateConfig(db, kinds)` two-argument call sites. */
function defaultPropagationDeps(): PropagationDeps {
  defaultDepsCache.deps ??= {
    kr: keyringFromEnv(env),
    coreClient: createCoreClient()
  };
  return defaultDepsCache.deps;
}

// The tail of the propagation chain: one render-and-reload at a time (`serialized`).
const propagationChain: { tail: Promise<unknown> } = {
  tail: Promise.resolve()
};

/**
 * Runs `task` once every propagation started before it has settled, whatever its outcome. Two
 * writes propagating side by side could otherwise render in one order and write the files in the
 * other: the older render, read before the newer write committed, would land last, and both
 * reloads would load it, leaving that write out of Asterisk until the next one (§3.1, §9.1).
 */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = propagationChain.tail.then(task, task);
  propagationChain.tail = run.catch(() => undefined);
  return run;
}

/**
 * Renders the PJSIP/hints/MoH configuration from the live database onto the `asterisk-config`
 * volume (§9.1). All four files are rewritten together, since a partial rewrite could leave them
 * inconsistent with each other.
 */
async function renderConfig(db: Db, deps: PropagationDeps): Promise<void> {
  const input = await loadRenderInput(db, deps.kr);
  const rendered = render(input);
  const dir = deps.genDir ?? asteriskGenDirFromEnv();
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(rendered).map(([filename, contents]) =>
      writeFileAtomically(path.join(dir, filename), contents)
    )
  );
}

/**
 * Tells `core` that configuration it reads has changed, so it drops its config cache (§3.1
 * "Config propagation"). Where `kinds` names Asterisk modules, the configuration is rendered
 * first (`renderConfig`) and `core` reloads those modules; a write that changes nothing Asterisk
 * holds only invalidates the cache. Propagations run one at a time (`serialized`). `deps` defaults to the environment; a caller overrides it
 * for tests.
 */
export async function propagateConfig(
  db: Db,
  kinds: ReloadKind[],
  deps: PropagationDeps = defaultPropagationDeps()
): Promise<void> {
  await serialized(async () => {
    if (kinds.length > 0) {
      await renderConfig(db, deps);
    }
    await deps.coreClient.configChanged(kinds);
  });
}

/**
 * The boot-time propagation (§3.1, §9.1), run once after the first-boot seed and before `api`
 * serves: the volume holds nothing a fresh stack's seed wrote (the parking-slot hints, the hold
 * music classes, §6.3 "First boot") and, after an upgrade, the previous release's render, until
 * something renders the database again. A render failure is logged rather than thrown, so `api`
 * still serves and the next write renders again. `core` starts only once `api` is healthy
 * (§6.3) and reloads every rendered module at its own boot, so on a fresh start its refusal here
 * is expected; it only matters when `api` restarted alone.
 */
export async function propagateAtBoot(
  db: Db,
  log: Logger,
  deps: PropagationDeps = defaultPropagationDeps()
): Promise<void> {
  await serialized(async () => {
    try {
      await renderConfig(db, deps);
    } catch (error) {
      log.error({ error }, 'boot: config render failed');
      return;
    }
    try {
      await deps.coreClient.configChanged(ALL_RELOAD_KINDS);
    } catch (error) {
      log.info(
        { error },
        'boot: core not reachable; it reloads the rendered config at its own start'
      );
    }
  });
}
