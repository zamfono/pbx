import process from 'node:process';
import { z } from 'zod';

import { resolveVersion, type ZamfonoVersion } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { updaterClient, type UpdaterStatus } from './_updater.js';

type Output = {
  /** What `api` runs, the process answering this call. */
  api: ZamfonoVersion;
  /** What `core` reports it runs; `null` while `core` does not answer. */
  core: ZamfonoVersion | null;
  /**
   * The updater's view (§6.3 "Updates"): the latest release, whether `system.update` can take
   * the stack there, and how the last update went; `unavailable` says why there is none.
   */
  update: UpdaterStatus | { unavailable: string };
};

async function updateStatus(): Promise<Output['update']> {
  const client = updaterClient();
  if (client === undefined) {
    return {
      unavailable:
        'UPDATER_TOKEN is not set in .env; updates run only by update.sh on the host'
    };
  }
  return client.status().catch((error: unknown) => ({
    unavailable: `the updater did not answer: ${error instanceof Error ? error.message : String(error)}`
  }));
}

/** Reads `core`'s version; installed at boot by `hooks.server.ts`, unset in tests. */
export type CoreVersionLookup = () => Promise<ZamfonoVersion>;

// One mutable module slot, held in an object rather than a `let`, as `trunks/_status.ts` holds
// its lookup: ESLint's `init-declarations` and `no-undef-init` leave no way to declare an
// optional `let` binding directly.
const lookupHolder: { current: CoreVersionLookup | undefined } = {
  current: undefined
};

export function setCoreVersionLookup(
  lookup: CoreVersionLookup | undefined
): void {
  lookupHolder.current = lookup;
}

/**
 * `GET /system/info` (§7 "Version", §10.3): the version and commit `api` and `core` each run, and
 * the latest release with how the last update went (§6.3 "Updates"), for anyone signed in. The MCP `serverInfo.version` carries `api`'s too, but only in the connection
 * handshake, which no tool can read; `/healthz` answers without a login and never shows it.
 */
export const info = defineOperation<Record<string, never>, Output>({
  name: 'system.info',
  description:
    'Reads the version and commit the stack runs, for api and core separately, and the latest release and last update.',
  input: z.object({}).strict(),
  minRole: 'user',
  readOnly: true,
  run: async () => {
    const [core, update] = await Promise.all([
      lookupHolder.current
        ? lookupHolder.current().catch(() => null)
        : Promise.resolve(null),
      updateStatus()
    ]);
    return { api: resolveVersion(process.env), core, update };
  }
});
