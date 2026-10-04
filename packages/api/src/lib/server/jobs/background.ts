/**
 * Every background job `api` runs, started once from `hooks.server.ts`'s `init`: the first-boot
 * seed and the boot render (§6.3 "First boot", §3.1, §9.1), the key-rotation sweep (§5.4), the
 * certificate sync (§6.4), backups (§6.5), the automatic update (§6.3 "Updates"), the daily purge
 * (§5.9), webhook delivery and the relay of `core`'s event stream (§3.1 "Events", §10.6), and the
 * Ringotel re-registration after an Asterisk restart (§10.4).
 *
 * They all live in the SvelteKit bundle, the one that also holds `runOperation` and every
 * operation: an operation hands a job its work by calling it (`backups.runs.start` →
 * `queueRun`, a write → `propagateConfig`), in one module instance, with no table polled in
 * between. `server.ts`, a separate bundle with its own copy of every module, keeps only what
 * SvelteKit cannot hold, the HTTP server and the `/events` sockets, and receives the events
 * through `eventSink.ts`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as env from '$app/env/private';
import type { Logger } from 'pino';

import type { Db, Envelope } from '@zamfono/shared';

import { getCoreClient } from '../coreClient.js';
import { connectCoreEvents } from '../coreEvents.js';
import { publishEvent } from '../eventSink.js';
import { updateMailSender } from '../mail/owners.js';
import { onceConfigPropagated } from '../ops/afterCommit.js';
import { oweDevicePushesAtStart } from '../ops/devices/_ringotelPush.js';
import { retryPendingRoster } from '../ops/roster.js';
import { retryPendingProfile } from '../ops/settings/profilePush.js';
import { updaterClient } from '../ops/system/_updater.js';
import { propagateAtBoot } from '../propagation.js';
import type { Keyring } from '../secretbox.js';
import { seedIfEmpty } from '../seed.js';
import { seedBackupTarget } from '../seedBackupTarget.js';
import { WebhookDispatcher } from '../webhooks.js';
import { scheduleAutoUpdate, type AutoUpdateScheduler } from './autoUpdate.js';
import type { BackupJobDeps, Bus } from './backup.js';
import type { ExecFn } from './backupBackends.js';
import { backupEnabledTargets } from './backupTurns.js';
import { startCertSync, type CertSyncScheduler } from './certSync.js';
import { scheduleBackups } from './cron.js';
import { reencryptSweep } from './keyRotation.js';
import { coreBusy } from './maintenanceGiveUp.js';
import { createMaintenanceGate } from './maintenanceWindow.js';
import { scheduleRetention } from './retention.js';
import { watchAsteriskRestarts } from './ringotelRereg.js';

const execFileAsync = promisify(execFile);

/**
 * Production `ExecFn` for `scheduleBackups` (`backup.ts`/`backupBackends.ts`): runs `file`,
 * writing `options.input` to stdin when given — `rclone obscure`'s only way to take a credential
 * off argv. `execFileAsync`'s returned promise carries the spawned `ChildProcess` as `.child`
 * (Node's own `promisify(execFile)` contract), so its stdin is reachable without a hand-rolled
 * `child_process` wrapper.
 */
export const execCommand: ExecFn = (file, args, options) => {
  const result = execFileAsync(file, args, { env: options.env });
  if (options.input !== undefined) {
    result.child.stdin?.end(options.input);
  }
  return result;
};

/** `CORE_URL` (`http://core:3000`, §6.3) as the internal event stream's `ws://` URL. */
function coreEventsUrl(coreUrl: string): string {
  return `${coreUrl.replace(/^http/u, 'ws')}/internal/events`;
}

export type BackgroundJobs = { stop(): void };

/** The certificate sync (§6.4 "The same sync runs at `api` start"); a failed start costs only it. */
function syncCertificates(db: Db, log: Logger): CertSyncScheduler | null {
  try {
    return startCertSync({ db, coreClient: getCoreClient() });
  } catch (error) {
    log.error({ error }, 'boot: certificate-sync scheduler failed to start');
    return null;
  }
}

/** The automatic update (§6.3 "Updates"); a failed start costs only it. */
function startAutoUpdate(
  db: Db,
  kr: Keyring,
  backup: BackupJobDeps,
  log: Logger
): AutoUpdateScheduler | null {
  try {
    const core = getCoreClient();
    return scheduleAutoUpdate({
      db,
      backUp: async () => backupEnabledTargets(db, kr, backup),
      gate: createMaintenanceGate({
        db,
        work: 'autoUpdate',
        busy: async () => coreBusy(core)
      }),
      updater: updaterClient,
      send: updateMailSender(db, kr)
    });
  } catch (error) {
    log.error({ error }, 'boot: automatic-update scheduler failed to start');
    return null;
  }
}

/**
 * The seed, the default backup target and the boot render, in that order and awaited: the
 * seed's failure propagates, so `api` never serves a database without an owner, a settings row
 * or its parking slots, and the Asterisk configuration is rendered from that database before
 * `api` reports healthy and so before `core` starts and reloads it. A propagation still owed
 * from before the start also owes the device pushes that waited for it (§3.1).
 */
export async function runBootSteps(
  db: Db,
  kr: Keyring,
  log: Logger
): Promise<void> {
  const seeded = await seedIfEmpty(db, env, kr, env.MEDIA_DIR, log);
  log.info({ seeded }, 'boot: first-boot seed');
  await seedBackupTarget(db, env, kr, log);
  await oweDevicePushesAtStart(db);
  await propagateAtBoot(db, log);
}

/**
 * `core`'s event stream, relayed to the `/events` sockets and to webhooks; its `asterisk.started`
 * frames and every (re)connection drive the Ringotel re-registration (§10.4 "After a restart"),
 * and `api`'s start and each `asterisk.started` retry a pending tenant profile push once (§10.4
 * "Tenant profile push").
 */
function relayCoreEvents(
  db: Db,
  dispatcher: WebhookDispatcher,
  log: Logger
): { close: () => void } {
  const rereg = watchAsteriskRestarts({
    db,
    lookup: async () => getCoreClient().version(),
    // The profile and the roster reach the apps only once Asterisk holds them, as the device
    // pushes do.
    retryPending: trigger =>
      onceConfigPropagated(db, async later => {
        await retryPendingProfile(later, trigger);
        await retryPendingRoster(later);
      })
  });
  return connectCoreEvents({
    url: coreEventsUrl(env.CORE_URL),
    onOpen: () => {
      rereg.streamConnected();
    },
    onAsteriskStarted: asteriskStartedAt => {
      rereg.asteriskStarted(asteriskStartedAt);
    },
    onEvent: envelope => {
      publishEvent(envelope);
      dispatcher.enqueue(envelope).catch((error: unknown) => {
        log.error({ error, eventId: envelope.id }, 'webhook delivery failed');
      });
    }
  });
}

/**
 * Runs the boot steps, then the key-rotation sweep, and resolves once both are done, which
 * SvelteKit waits on before it serves anything: a request answered mid-sweep could read a secret
 * the sweep is re-encrypting. A sweep that throws is logged and lets requests through, since
 * `/healthz`'s remaining count already reports it. The recurring jobs start after, and
 * `stop()` ends every one of them.
 */
export async function startBackgroundJobs(
  db: Db,
  kr: Keyring,
  log: Logger
): Promise<BackgroundJobs> {
  await runBootSteps(db, kr, log);
  try {
    await reencryptSweep(db, kr, log);
  } catch (error) {
    log.error({ error }, 'boot: key-rotation sweep failed');
  }
  const certSync = syncCertificates(db, log);
  const dispatcher = new WebhookDispatcher({ db, kr });
  // The deliveries the previous process left pending (§10.6), alongside the new ones.
  dispatcher.resume().catch((error: unknown) => {
    log.error({ error }, 'webhook delivery failed');
  });
  const bus: Bus = {
    publish: (envelope: Envelope) => {
      publishEvent(envelope);
    },
    enqueue: envelope => dispatcher.enqueue(envelope)
  };
  const backupDeps: BackupJobDeps = {
    exec: execCommand,
    mediaDir: env.MEDIA_DIR,
    bus
  };
  const backups = scheduleBackups(db, kr, backupDeps);
  const autoUpdate = startAutoUpdate(db, kr, backupDeps, log);
  const retention = scheduleRetention(db);
  const coreEvents = relayCoreEvents(db, dispatcher, log);
  return {
    stop: () => {
      coreEvents.close();
      retention.stop();
      autoUpdate?.stop();
      backups.stop();
      certSync?.stop();
    }
  };
}
