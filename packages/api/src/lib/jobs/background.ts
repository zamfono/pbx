/**
 * Every background job `api` runs, started once from `hooks.server.ts`'s `init`: the first-boot
 * seed and the boot render (§6.3 "First boot", §3.1, §9.1), the key-rotation sweep (§5.4), the
 * certificate sync (§6.4), backups (§6.5), the daily purge (§5.9), webhook delivery and the relay
 * of `core`'s event stream (§3.1 "Events", §10.6), and the Ringotel re-registration after an
 * Asterisk restart (§10.4).
 *
 * They all live in the SvelteKit bundle, the one that also holds `runOperation` and every
 * operation: an operation hands a job its work by calling it (`backups.runs.start` →
 * `queueRun`, a write → `propagateConfig`), in one module instance, with no table polled in
 * between. `server.ts`, a separate bundle with its own copy of every module, keeps only what
 * SvelteKit cannot hold, the HTTP server and the `/events` sockets, and receives the events
 * through `eventSink.ts`.
 */
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

import type { Db, Envelope } from '@zamfono/shared';

import { coreUrlFromEnv, fetchCoreVersion } from '../coreClient.js';
import { connectCoreEvents } from '../coreEvents.js';
import { publishEvent } from '../eventSink.js';
import { propagateAtBoot } from '../propagation.js';
import type { Keyring } from '../secretbox.js';
import { seedIfEmpty } from '../seed.js';
import { seedBackupTarget } from '../seedBackupTarget.js';
import { WebhookDispatcher } from '../webhooks.js';
import type { Bus, ExecFn } from './backup.js';
import { getCertSyncScheduler, type CertSyncScheduler } from './certSync.js';
import { scheduleBackups } from './cron.js';
import { reencryptSweep } from './keyRotation.js';
import { scheduleRetention } from './retention.js';
import { watchAsteriskRestarts } from './ringotelRereg.js';

const DEFAULT_MEDIA_DIR = '/media';
const execFileAsync = promisify(execFile);

/** The shared media volume root (`MEDIA_DIR`, `images/api/Dockerfile`), read at call time so tests can override it. */
function mediaDirFromEnv(): string {
  return process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR;
}

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
function startCertSync(log: Logger): CertSyncScheduler | null {
  try {
    return getCertSyncScheduler();
  } catch (error) {
    log.error({ error }, 'boot: certificate-sync scheduler failed to start');
    return null;
  }
}

/**
 * The seed, the default backup target and the boot render, in that order and awaited: the
 * seed's failure propagates, so `api` never serves a database without an owner, a settings row
 * or its parking slots, and the Asterisk configuration is rendered from that database before
 * `api` reports healthy and so before `core` starts and reloads it.
 */
export async function runBootSteps(
  db: Db,
  kr: Keyring,
  log: Logger
): Promise<void> {
  const seeded = await seedIfEmpty(db, process.env, kr, mediaDirFromEnv(), log);
  log.info({ seeded }, 'boot: first-boot seed');
  await seedBackupTarget(db, process.env, kr, log);
  await propagateAtBoot(db, log);
}

/**
 * `core`'s event stream, relayed to the `/events` sockets and to webhooks; its `asterisk.started`
 * frames and every (re)connection drive the Ringotel re-registration (§10.4 "After a restart").
 */
function relayCoreEvents(
  db: Db,
  dispatcher: WebhookDispatcher,
  log: Logger
): { close: () => void } {
  const rereg = watchAsteriskRestarts({ db, lookup: () => fetchCoreVersion() });
  return connectCoreEvents({
    url: coreEventsUrl(coreUrlFromEnv()),
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
  const certSync = startCertSync(log);
  const dispatcher = new WebhookDispatcher({ db, kr });
  const bus: Bus = {
    publish: (envelope: Envelope) => {
      publishEvent(envelope);
    },
    enqueue: envelope => dispatcher.enqueue(envelope)
  };
  const backups = scheduleBackups(db, kr, {
    exec: execCommand,
    mediaDir: mediaDirFromEnv(),
    bus
  });
  const retention = scheduleRetention(db);
  const coreEvents = relayCoreEvents(db, dispatcher, log);
  return {
    stop: () => {
      coreEvents.close();
      retention.stop();
      backups.stop();
      certSync?.stop();
    }
  };
}
