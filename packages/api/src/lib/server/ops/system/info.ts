import * as env from '$app/env/private';
import { z } from 'zod';

import { processStartedAtIso, resolveVersion, type Db } from '@zamfono/shared';

import { skippedConfigRows } from '#lib/server/configRenderSkips.js';
import { getCoreClient } from '#lib/server/coreClient.js';
import { lastGiveUps } from '#lib/server/jobs/maintenanceGiveUp.js';
import {
  isRelayConfigured,
  RELAY_ERROR_CLASSES,
  relayState
} from '#lib/server/mail/index.js';
import { SKIPPED_ROW_TYPES } from '#lib/server/pjsip/skippedRows.js';
import { isProfilePending } from '#lib/server/provisioning/profilePending.js';
import { stackIpv4 } from '#lib/server/stackAddress.js';

import { isRosterPending } from '../roster.js';
import { defineOperation } from '../types.js';
import { hostOut, hostStatus } from './_host.js';
import {
  autoUpdateEnabled,
  autoUpdateFailure,
  autoUpdateFailureOut,
  loadUpdateState
} from './_state.js';
import { updateStatus } from './_status.js';
import { updaterClient } from './_updater.js';
import { updateOut, versionOut } from './_wire.js';

// When this process started, however late this module loads, so a restart is visible (§10.3).
const apiStartedAt = processStartedAtIso();

const lastGiveUpOut = z
  .object({ at: z.string(), reason: z.string() })
  .nullable();

// §10.3 "System": a user reads only the stack's version and its address; everything else, a
// diagnosis of the stack, only admins and owners.
const ADMIN_ONLY = ' Admins and owners only.';

const outputSchema = z.object({
  api: versionOut
    .partial({ revision: true, display: true })
    .extend({ startedAt: z.string().optional() })
    .describe(
      'What api runs, the process answering this call, and since when; a user gets only version.'
    ),
  core: versionOut
    .extend({ startedAt: z.string(), asteriskStartedAt: z.string().nullable() })
    .nullable()
    .optional()
    .describe(
      `What core runs, since when, and since when its Asterisk runs (null while ARI is down); null while core does not answer.${ADMIN_ONLY}`
    ),
  update: updateOut
    .optional()
    .describe(`${updateOut.description ?? ''}${ADMIN_ONLY}`),
  autoUpdate: z
    .object({ enabled: z.boolean(), failed: autoUpdateFailureOut.nullable() })
    .optional()
    .describe(
      `settings.autoUpdate, and why the last automatic update failed and after how many attempts on its release, until an update succeeds.${ADMIN_ONLY}`
    ),
  maintenanceGate: z
    .object({
      certSync: lastGiveUpOut,
      autoUpdate: lastGiveUpOut,
      reboot: lastGiveUpOut
        .optional()
        .describe('Present only where .env sets HOST_CONTROL=true.')
    })
    .optional()
    .describe(
      `When the maintenance gate last gave up on each work it holds back, and what kept the system busy; null for one it never gave up on.${ADMIN_ONLY}`
    ),
  host: hostOut.describe(`${hostOut.description ?? ''}${ADMIN_ONLY}`),
  ringotel: z
    .object({ profilePending: z.boolean(), rosterPending: z.boolean() })
    .optional()
    .describe(
      `profilePending: a tenant profile change is in force on the PBX but has not reached Ringotel yet; rosterPending: a roster change is, likewise.${ADMIN_ONLY}`
    ),
  mail: z
    .object({
      ok: z.boolean(),
      at: z.string(),
      error: z
        .object({ class: z.enum(RELAY_ERROR_CLASSES), message: z.string() })
        .nullable()
    })
    .nullable()
    .optional()
    .describe(
      `The mail relay's last check or send: whether it succeeded, when, and on a failure its class (unreachable, tls, authentication or rejected) and the relay's own message; null while no relay is configured or before the first.${ADMIN_ONLY}`
    ),
  skippedConfigRows: z
    .array(
      z.object({
        type: z.enum(SKIPPED_ROW_TYPES),
        id: z.string(),
        field: z.string()
      })
    )
    .optional()
    .describe(
      `The rows the latest config render left out, since a value of theirs cannot be written into Asterisk's configuration: each object's type and id and the field holding that value, as \`<object>.<column>\`, never the value; empty while none.${ADMIN_ONLY}`
    ),
  stack: z
    .object({ domain: z.string(), ipv4: z.string() })
    .describe(
      "The stack's public name and the IPv4 address SIP and media use: EXTERNAL_IPV4 in the ports mode, STACK_IPV4 in the macvlan mode."
    )
});
type Output = z.infer<typeof outputSchema>;

/** `failed` stays `null` without updates through the API, which automatic updates need; the record is kept. */
async function autoUpdateStatus(
  db: Db
): Promise<NonNullable<Output['autoUpdate']>> {
  const [enabled, row] = await Promise.all([
    autoUpdateEnabled(db),
    loadUpdateState(db)
  ]);
  const failed = updaterClient() === undefined ? null : autoUpdateFailure(row);
  return { enabled, failed };
}

/**
 * `GET /system/info` (§7 "Version", §10.3): the version and commit `api` and `core` each run and
 * since when, when Asterisk started, the latest release with how the last update went and who asked for it, whether automatic updates are on and why the last one failed, after how many attempts (§6.3 "Automatic updates"), when and why the maintenance gate last gave up (§6.4), whether a tenant profile or roster change still waits for Ringotel (§10.4), the mail relay's last check or send (§10.2 "Relay check"), the rows the latest config render left out (§3.1 "Config propagation"), and the stack's domain and public IPv4 address (§6.1). A user gets only `api.version` and `stack`:
 * the rest diagnoses the stack, for admins and owners. The MCP `serverInfo.version` carries `api`'s
 * too, but only in the connection handshake, which no tool can read; `/healthz` answers without a
 * login and never shows it.
 */
export const info = defineOperation({
  name: 'system.info',
  description:
    'Reads the version, commit and start time of api and core separately, when Asterisk started, the latest release and last update with who asked for it, whether automatic updates are on and why and how often the last one failed, when and why the maintenance gate last gave up, whether the host waits for a reboot and one is scheduled (only with HOST_CONTROL), whether a tenant profile or roster change still waits for Ringotel, how the last check or send of the mail relay went, which rows the latest config render left out, and the domain of the stack and the public IPv4 address its SIP and media use. A user gets only api.version and stack.',
  input: z.object({}).strict(),
  output: outputSchema,
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async ctx => {
    const stack = { domain: env.FQDN, ipv4: stackIpv4(env) };
    if (ctx.actor.role === 'user') {
      return { api: { version: resolveVersion(env).version }, stack };
    }
    const [
      core,
      update,
      autoUpdate,
      maintenanceGate,
      profilePending,
      rosterPending,
      relayConfigured,
      host
    ] = await Promise.all([
      getCoreClient()
        .version()
        .catch(() => null),
      updateStatus(),
      autoUpdateStatus(ctx.db),
      lastGiveUps(ctx.db),
      isProfilePending(ctx.db),
      isRosterPending(ctx.db),
      isRelayConfigured(ctx.db),
      hostStatus(ctx.db, async client => client.read())
    ]);
    return {
      api: { ...resolveVersion(env), startedAt: apiStartedAt },
      core,
      update,
      autoUpdate,
      maintenanceGate: {
        certSync: maintenanceGate.certSync,
        autoUpdate: maintenanceGate.autoUpdate,
        ...(host === undefined ? {} : { reboot: maintenanceGate.reboot })
      },
      ...(host === undefined ? {} : { host }),
      ringotel: { profilePending, rosterPending },
      mail: relayConfigured ? relayState() : null,
      skippedConfigRows: [...skippedConfigRows()],
      stack
    };
  }
});
