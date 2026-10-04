import * as env from '$app/env/private';
import { z } from 'zod';

import {
  processStartedAtIso,
  resolveVersion,
  type CoreVersionResponse,
  type Db,
  type MaintenanceWork,
  type UpdaterStatus,
  type ZamfonoVersion
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import { errorMessage } from '#lib/server/errors.js';
import {
  lastGiveUps,
  type LastGiveUp
} from '#lib/server/jobs/maintenanceGiveUp.js';
import { isProfilePending } from '#lib/server/provisioning/profilePending.js';
import { stackIpv4 } from '#lib/server/stackAddress.js';

import { isRosterPending } from '../roster.js';
import { defineOperation } from '../types.js';
import {
  autoUpdateEnabled,
  autoUpdateFailure,
  loadUpdateState,
  type AutoUpdateFailure
} from './_state.js';
import { updaterClient } from './_updater.js';

// When this process started, however late this module loads, so a restart is visible (§10.3).
const apiStartedAt = processStartedAtIso();

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
   * When the maintenance gate last gave up on each work it holds back, the certificate swap and
   * the automatic update, and what kept the system busy; `null` for one it never gave up on
   * (§6.4 "Maintenance gate").
   */
  maintenanceGate: Record<MaintenanceWork, LastGiveUp | null>;
  /**
   * `profilePending`: a tenant profile change, the emergency numbers among them, is stored and
   * in force on the PBX but has not reached Ringotel yet (§10.4 "Tenant profile push");
   * `rosterPending`: a roster change is, likewise (§10.4 "Colleague presence").
   */
  ringotel: { profilePending: boolean; rosterPending: boolean };
  /**
   * The stack's public name and the IPv4 address SIP and media use (§6.1): `EXTERNAL_IPV4` in the
   * ports mode, `STACK_IPV4` in the macvlan mode.
   */
  stack: { domain: string; ipv4: string };
};

async function updateStatus(): Promise<Output['update']> {
  const client = updaterClient();
  if (client === undefined) {
    return {
      unavailable:
        'UPDATER_TOKEN is not set in .env; updates run only by update.sh on the host'
    };
  }
  try {
    return await client.status();
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

/**
 * `GET /system/info` (§7 "Version", §10.3): the version and commit `api` and `core` each run and
 * since when, when Asterisk started, the latest release with how the last update went and who asked for it, whether automatic updates are on and why the last one failed, after how many attempts (§6.3 "Automatic updates"), when and why the maintenance gate last gave up (§6.4), whether a tenant profile or roster change still waits for Ringotel (§10.4), and the stack's domain and public IPv4 address (§6.1), for anyone signed in. The MCP `serverInfo.version` carries `api`'s too, but only in the connection
 * handshake, which no tool can read; `/healthz` answers without a login and never shows it.
 */
export const info = defineOperation<Record<string, never>, Output>({
  name: 'system.info',
  description:
    'Reads the version, commit and start time of api and core separately, when Asterisk started, the latest release and last update with who asked for it, whether automatic updates are on and why and how often the last one failed, when and why the maintenance gate last gave up, whether a tenant profile or roster change still waits for Ringotel, and the domain of the stack and the public IPv4 address its SIP and media use.',
  input: z.object({}).strict(),
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async ctx => {
    const [
      core,
      update,
      autoUpdate,
      maintenanceGate,
      profilePending,
      rosterPending
    ] = await Promise.all([
      getCoreClient()
        .version()
        .catch(() => null),
      updateStatus(),
      autoUpdateStatus(ctx.db),
      lastGiveUps(ctx.db),
      isProfilePending(ctx.db),
      isRosterPending(ctx.db)
    ]);
    return {
      api: { ...resolveVersion(env), startedAt: apiStartedAt },
      core,
      update,
      autoUpdate,
      maintenanceGate,
      ringotel: { profilePending, rosterPending },
      stack: { domain: env.FQDN, ipv4: stackIpv4(env) }
    };
  }
});
