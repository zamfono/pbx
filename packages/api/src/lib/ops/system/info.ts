import process from 'node:process';
import { z } from 'zod';

import {
  resolveVersion,
  type CoreVersionResponse,
  type ZamfonoVersion
} from '@zamfono/shared';

import { isProfilePending } from '../../provisioning/profilePending.js';
import { defineOperation } from '../types.js';
import { updaterClient, type UpdaterStatus } from './_updater.js';

const MS_PER_SECOND = 1000;

// When this process started, however late this module loads, so a restart is visible (§10.3).
const apiStartedAt = new Date(
  Date.now() - process.uptime() * MS_PER_SECOND
).toISOString();

type Output = {
  /** What `api` runs, the process answering this call, and since when. */
  api: ZamfonoVersion & { startedAt: string };
  /**
   * What `core` reports it runs, since when, and since when its Asterisk runs (`null` while ARI
   * is down); `null` while `core` does not answer.
   */
  core: CoreVersionResponse | null;
  /**
   * The updater's view (§6.3 "Updates"): the latest release, whether `system.update` can take
   * the stack there, and how the last update went; `unavailable` says why there is none.
   */
  update: UpdaterStatus | { unavailable: string };
  /**
   * `profilePending`: a tenant profile change, the emergency numbers among them, is stored and
   * in force on the PBX but has not reached Ringotel yet (§10.4 "Tenant profile push").
   */
  ringotel: { profilePending: boolean };
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
export type CoreVersionLookup = () => Promise<CoreVersionResponse>;

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
 * `GET /system/info` (§7 "Version", §10.3): the version and commit `api` and `core` each run and
 * since when, when Asterisk started, the latest release with how the last update went (§6.3 "Updates"), and whether a tenant profile change still waits for Ringotel (§10.4), for anyone signed in. The MCP `serverInfo.version` carries `api`'s too, but only in the connection
 * handshake, which no tool can read; `/healthz` answers without a login and never shows it.
 */
export const info = defineOperation<Record<string, never>, Output>({
  name: 'system.info',
  description:
    'Reads the version, commit and start time of api and core separately, when Asterisk started, the latest release and last update, and whether a tenant profile change still waits for Ringotel.',
  input: z.object({}).strict(),
  minRole: 'user',
  readOnly: true,
  run: async ctx => {
    const [core, update, profilePending] = await Promise.all([
      lookupHolder.current
        ? lookupHolder.current().catch(() => null)
        : Promise.resolve(null),
      updateStatus(),
      isProfilePending(ctx.db)
    ]);
    return {
      api: { ...resolveVersion(process.env), startedAt: apiStartedAt },
      core,
      update,
      ringotel: { profilePending }
    };
  }
});
