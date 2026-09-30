/**
 * TLS certificate sync (§6.4 "TLS certificates"): compares the `proxy` image's `cert_obtained`
 * hook's copy on `caddy-data` (`zamfono/cert.pem`/`privkey.pem`, images/proxy/zamfono-cert-hook)
 * with the copy on the `asterisk-config` volume, and on a change copies chain and key across —
 * at once for a fresh stack's self-signed placeholder or an expiring current certificate,
 * otherwise at the next maintenance moment `nextMaintenanceMoment` resolves — then triggers the
 * PJSIP reload through `core`. Runs on a poll, and can be run early by `notify()` when the hook's
 * own `POST /internal/certificate` reaches `api` (routes/internal/certificate/+server.ts).
 */
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';

import { MINUTES_PER_HOUR, MS_PER_SECOND, type Db } from '@zamfono/shared';

import { createCoreClient, type CoreClient } from '../coreClient.js';
import { getDb } from '../db.js';
import { asteriskGenDirFromEnv } from '../propagation.js';
import {
  caddyDataDirFromEnv,
  copyCertificate,
  findCaddyCert,
  isMatchingPair,
  TLS_CERT_FILENAME
} from './certSyncFiles.js';
import { nextMaintenanceMoment } from './reloadTiming.js';

const logger = pino({ name: 'certSync' });

export type CertSyncStatus = 'missing' | 'ok' | 'unknown';

export type CertSyncDeps = {
  db: Db;
  coreClient: CoreClient;
  genDir?: string;
  caddyDataDir?: string;
  now?: () => Date;
};

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Whether `certPem` is self-signed (its own issuer, §6.4 "Fresh stack" placeholder), or unparsable. */
function isSelfSigned(certPem: Buffer): boolean {
  try {
    const cert = new X509Certificate(certPem);
    return cert.issuer === cert.subject;
  } catch {
    return true;
  }
}

/** The moment to apply the change at: at once for a placeholder or an expiring current certificate. */
async function dueAt(
  db: Db,
  now: Date,
  currentCrt: Buffer | null
): Promise<Date> {
  if (currentCrt === null || isSelfSigned(currentCrt)) {
    return now;
  }
  const scheduled = await nextMaintenanceMoment(db, now);
  const currentExpiresAt = new Date(new X509Certificate(currentCrt).validTo);
  return currentExpiresAt.getTime() < scheduled.getTime() ? now : scheduled;
}

type PendingChange = { sourceHash: string; applyAtMs: number };

// Keyed by the `CertSyncDeps` object a caller keeps passing across polls (the scheduler below
// reuses one instance): once a target moment is resolved for a given source certificate it is
// held here and compared against `now` on every later poll, instead of being resolved afresh
// each time. Resolving afresh against the current `now` would keep landing on a moment still
// ahead of it (e.g. "the next 3am" recomputed just after 3am is tomorrow's 3am), so the change
// would never come due.
const pendingChangeByDeps = new WeakMap<CertSyncDeps, PendingChange>();

// Keyed the same way as `pendingChangeByDeps`, but tracks the far side of a copy: once
// `copyCertificate` has written a source certificate's hash to the volume, that hash stays here
// until `configChanged` confirms the reload, so a poll that finds the file already up to date
// still retries the reload.
const reloadPendingHashByDeps = new WeakMap<CertSyncDeps, string>();

/**
 * One check-and-act pass (§6.4): `'missing'` while the hook's copy does not exist yet on
 * `caddy-data` (the alert case: a fresh stack before its first certificate, or a `proxy` upgrade
 * gone wrong); `'ok'` otherwise, whether nothing had changed, the change was applied now, or it
 * was left for a later poll to apply once due.
 */
export async function runCertSync(deps: CertSyncDeps): Promise<CertSyncStatus> {
  const genDir = deps.genDir ?? asteriskGenDirFromEnv();
  const caddyDataDir = deps.caddyDataDir ?? caddyDataDirFromEnv();
  const source = await findCaddyCert(caddyDataDir);
  if (!source) {
    pendingChangeByDeps.delete(deps);
    reloadPendingHashByDeps.delete(deps);
    return 'missing';
  }
  const currentCrtPath = path.join(genDir, 'tls', TLS_CERT_FILENAME);
  const [sourceCrt, sourceKey, currentCrt] = await Promise.all([
    readFile(source.crt),
    readFile(source.key),
    readFile(currentCrtPath).catch(() => null)
  ]);
  if (!isMatchingPair(sourceCrt, sourceKey)) {
    // Read between the hook's two renames; the next pass (or the hook's notification) sees both.
    logger.warn(
      'certSync: the certificate and key on caddy-data do not match yet; retrying on the next pass'
    );
    return 'ok';
  }
  const sourceHash = sha256(sourceCrt);
  const upToDate = currentCrt !== null && sha256(currentCrt) === sourceHash;
  const reloadPending = reloadPendingHashByDeps.get(deps) === sourceHash;
  if (upToDate && !reloadPending) {
    pendingChangeByDeps.delete(deps);
    return 'ok';
  }
  if (!upToDate) {
    const now = (deps.now ?? (() => new Date()))();
    const pending = pendingChangeByDeps.get(deps);
    const applyAt =
      pending?.sourceHash === sourceHash
        ? new Date(pending.applyAtMs)
        : await dueAt(deps.db, now, currentCrt);
    if (applyAt.getTime() > now.getTime()) {
      pendingChangeByDeps.set(deps, {
        sourceHash,
        applyAtMs: applyAt.getTime()
      });
      return 'ok';
    }
    pendingChangeByDeps.delete(deps);
    await copyCertificate(genDir, { crt: sourceCrt, key: sourceKey });
    reloadPendingHashByDeps.set(deps, sourceHash);
    logger.info(
      { sourceHash },
      'certSync: copied a new certificate onto asterisk-config'
    );
  }
  // `configChanged` rejecting here (a non-2xx from `core`) leaves `reloadPendingHashByDeps` set,
  // so the next poll retries this call alone, without re-copying an already up-to-date file.
  await deps.coreClient.configChanged(['pjsip']);
  reloadPendingHashByDeps.delete(deps);
  logger.info({ sourceHash }, 'certSync: triggered the pjsip reload');
  return 'ok';
}

/** The delay, in ms, before the next poll should run: the resolved moment when one is pending and closer than the regular poll interval, else `pollIntervalMs`. */
function nextPollDelayMs(
  deps: CertSyncDeps,
  now: () => Date,
  pollIntervalMs: number
): number {
  const pending = pendingChangeByDeps.get(deps);
  if (!pending) {
    return pollIntervalMs;
  }
  const untilDueMs = pending.applyAtMs - now().getTime();
  return Math.min(pollIntervalMs, Math.max(0, untilDueMs));
}

export type CertSyncScheduler = {
  status(): CertSyncStatus;
  /** Runs a pass right away (§6.4: the `POST /internal/certificate` notification), instead of
   * waiting for the next poll; the regular poll timer is reset around it so the two never race. */
  notify(): void;
  stop(): void;
};

const SECONDS_PER_MINUTE = 60;
// Coarser than the day-scale timing this job targets is enough (§6.4): the resolved moment is
// held across polls (`pendingChangeByDeps`), so a poll every hour still applies a scheduled
// change within the hour it comes due.
const POLL_INTERVAL_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * Runs `runCertSync` once immediately (§6.4 "The same sync runs at `api` start") and then on a
 * poll no coarser than an hour, drawn in to land exactly on a pending change's resolved moment
 * (`nextMaintenanceMoment`) whenever that falls sooner, exposing its last-known status for
 * `/healthz` and `/metrics` to read.
 */
export function scheduleCertSync(deps: CertSyncDeps): CertSyncScheduler {
  const now = deps.now ?? (() => new Date());
  const state: {
    current: CertSyncStatus;
    timer?: NodeJS.Timeout;
    stopped: boolean;
  } = { current: 'unknown', stopped: false };

  const tick = (): void => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    runCertSync(deps)
      .then(result => {
        state.current = result;
      })
      .catch(() => {
        // The previous status stands; the next poll retries.
      })
      .finally(() => {
        if (!state.stopped) {
          state.timer = setTimeout(
            tick,
            nextPollDelayMs(deps, now, POLL_INTERVAL_MS)
          );
        }
      });
  };
  tick();

  return {
    status: () => state.current,
    notify: () => {
      if (!state.stopped) {
        tick();
      }
    },
    stop: () => {
      state.stopped = true;
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }
    }
  };
}

const schedulerCache: { scheduler?: CertSyncScheduler } = {};

/**
 * The process-wide certificate-sync scheduler, started once from the environment (§6.4 "The
 * same sync runs at `api` start") and cached like `getDb()`, so `/healthz` and `/metrics` read
 * the same running instance the boot call started.
 */
export function getCertSyncScheduler(): CertSyncScheduler {
  schedulerCache.scheduler ??= scheduleCertSync({
    db: getDb(),
    coreClient: createCoreClient()
  });
  return schedulerCache.scheduler;
}
