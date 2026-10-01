import process from 'node:process';
import { z } from 'zod';

import {
  MS_PER_SECOND,
  resolveVersion,
  type CoreVersionResponse,
  type Db,
  type ZamfonoVersion
} from '@zamfono/shared';

import { errorMessage } from '#lib/errors.js';
import { isProfilePending } from '#lib/provisioning/profilePending.js';
import { stackDomain, stackIpv4 } from '#lib/stackAddress.js';

import { defineOperation } from '../types.js';
import {
  attributeStatus,
  autoUpdateEnabled,
  autoUpdateFailure,
  loadUpdateState,
  type AutoUpdateFailure
} from './_state.js';
import { updaterClient, type UpdaterStatus } from './_updater.js';

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
   * the stack there, and how the last update went and who asked for it; `unavailable` says why
   * there is none.
   */
  update: UpdaterStatus | { unavailable: string };
  /**
   * `settings.auto_update`, and why the last automatic update failed and after how many attempts
   * on its release, until an update succeeds (§6.3 "Automatic updates").
   */
  autoUpdate: { enabled: boolean; failed: AutoUpdateFailure | null };
  /**
   * `profilePending`: a tenant profile change, the emergency numbers among them, is stored and
   * in force on the PBX but has not reached Ringotel yet (§10.4 "Tenant profile push").
   */
  ringotel: { profilePending: boolean };
  /**
   * The stack's public name and the IPv4 address SIP and media use (§6.1): `EXTERNAL_IPV4` in the
   * ports mode, `STACK_IPV4` in the macvlan mode; each `null` while `.env` does not set it.
   */
  stack: { domain: string | null; ipv4: string | null };
};

async function updateStatus(db: Db): Promise<Output['update']> {
  const client = updaterClient();
  if (client === undefined) {
    return {
      unavailable:
        'UPDATER_TOKEN is not set in .env; updates run only by update.sh on the host'
    };
  }
  try {
    const [status, row] = await Promise.all([
      client.status(),
      loadUpdateState(db)
    ]);
    return attributeStatus(status, row);
  } catch (error) {
    return {
      unavailable: `the updater did not answer: ${errorMessage(error)}`
    };
  }
}

/** `failed` stays `null` without an updater, which automatic updates need; the record is kept. */
async function autoUpdateStatus(db: Db): Promise<Output['autoUpdate']> {
  const [enabled, row] = await Promise.all([
    autoUpdateEnabled(db),
    loadUpdateState(db)
  ]);
  const failed = updaterClient() === undefined ? null : autoUpdateFailure(row);
  return { enabled, failed };
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
 * since when, when Asterisk started, the latest release with how the last update went and who asked for it, whether automatic updates are on and why the last one failed, after how many attempts (§6.3 "Automatic updates"), whether a tenant profile change still waits for Ringotel (§10.4), and the stack's domain and public IPv4 address (§6.1), for anyone signed in. The MCP `serverInfo.version` carries `api`'s too, but only in the connection
 * handshake, which no tool can read; `/healthz` answers without a login and never shows it.
 */
export const info = defineOperation<Record<string, never>, Output>({
  name: 'system.info',
  description:
    'Reads the version, commit and start time of api and core separately, when Asterisk started, the latest release and last update with who asked for it, whether automatic updates are on and why and how often the last one failed, whether a tenant profile change still waits for Ringotel, and the domain of the stack and the public IPv4 address its SIP and media use.',
  input: z.object({}).strict(),
  minRole: 'user',
  readOnly: true,
  run: async ctx => {
    const [core, update, autoUpdate, profilePending] = await Promise.all([
      lookupHolder.current
        ? lookupHolder.current().catch(() => null)
        : Promise.resolve(null),
      updateStatus(ctx.db),
      autoUpdateStatus(ctx.db),
      isProfilePending(ctx.db)
    ]);
    return {
      api: { ...resolveVersion(process.env), startedAt: apiStartedAt },
      core,
      update,
      autoUpdate,
      ringotel: { profilePending },
      stack: { domain: stackDomain(process.env), ipv4: stackIpv4(process.env) }
    };
  }
});
