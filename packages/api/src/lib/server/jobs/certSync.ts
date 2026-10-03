/**
 * TLS certificate sync (§6.4 "TLS certificates"): compares the `proxy` image's `cert_obtained`
 * hook's copy on `caddy-data` (`zamfono/cert.pem`/`privkey.pem`, images/proxy/zamfono-cert-hook)
 * with the copy on the `asterisk-config` volume, and on a change copies chain and key across —
 * at once for a fresh stack's self-signed placeholder or an expiring current certificate,
 * otherwise once the maintenance gate opens (`maintenanceWindow.ts`) — then triggers the PJSIP
 * reload through `core`. Runs on a poll, and can be run early by `notifyCertSync()` when the
 * hook's own `POST /internal/certificate` reaches `api` (routes/internal/certificate/+server.ts).
 */
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';
import pino from 'pino';

import type { Db } from '@zamfono/shared';

import type { CoreClient } from '../coreClient.js';
import { sha256Hex } from '../hash.js';
import {
  copyCertificate,
  findCaddyCert,
  isMatchingPair,
  TLS_CERT_FILENAME
} from './certSyncFiles.js';
import { scheduleDrawnIn } from './drawnIn.js';
import { coreBusy } from './maintenanceGiveUp.js';
import {
  createMaintenanceGate,
  type MaintenanceGate
} from './maintenanceWindow.js';

const logger = pino({ name: 'certSync' });

export type CertSyncStatus = 'missing' | 'ok' | 'unknown';

export type CertSyncDeps = {
  db: Db;
  coreClient: CoreClient;
  genDir?: string;
  caddyDataDir?: string;
  now?: () => Date;
};

/** Whether `certPem` is self-signed (its own issuer, §6.4 "Fresh stack" placeholder), or unparsable. */
function isSelfSigned(certPem: Buffer): boolean {
  try {
    const cert = new X509Certificate(certPem);
    return cert.issuer === cert.subject;
  } catch {
    return true;
  }
}

/** A change waiting for its gate, and when that gate is next worth asking. */
type PendingChange = {
  sourceHash: string;
  gate: MaintenanceGate;
  nextCheckMs: number;
};

/**
 * The certificate sync over its deps, which keeps between its passes what it learnt: a change
 * waiting for its gate, and a copy whose reload `core` has not confirmed yet. Its owner runs
 * one pass at a time (`drawnIn.ts`).
 */
export class CertSync {
  readonly #deps: CertSyncDeps;
  // A source certificate's gate, which holds its resolved maintenance moment across passes,
  // until the change is applied or superseded.
  #pending: PendingChange | undefined;
  // The hash of a certificate copied onto the volume whose reload `core` has not confirmed yet,
  // so a pass that finds the file already up to date still retries the reload.
  #reloadPendingHash: string | undefined;

  constructor(deps: CertSyncDeps) {
    this.#deps = deps;
  }

  /** When the change waiting for its gate is next worth checking; `null` while none waits. */
  nextCheckAt(): Date | null {
    return this.#pending === undefined
      ? null
      : new Date(this.#pending.nextCheckMs);
  }

  /**
   * One check-and-act pass (§6.4): `'missing'` while the hook's copy does not exist yet on
   * `caddy-data` (the alert case: a fresh stack before its first certificate, or a `proxy`
   * upgrade gone wrong); `'ok'` otherwise, whether nothing had changed, the change was applied
   * now, or it was left for a later pass to apply once due.
   */
  async run(): Promise<CertSyncStatus> {
    const deps = this.#deps;
    const genDir = deps.genDir ?? env.ASTERISK_GEN_DIR;
    const caddyDataDir = deps.caddyDataDir ?? env.CADDY_DATA_DIR;
    const source = await findCaddyCert(caddyDataDir);
    if (!source) {
      this.#pending = undefined;
      this.#reloadPendingHash = undefined;
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
    const sourceHash = sha256Hex(sourceCrt);
    const upToDate =
      currentCrt !== null && sha256Hex(currentCrt) === sourceHash;
    if (upToDate && this.#reloadPendingHash !== sourceHash) {
      this.#pending = undefined;
      return 'ok';
    }
    if (!upToDate) {
      if (!(await this.#dueNow(sourceHash, currentCrt))) {
        return 'ok';
      }
      this.#pending = undefined;
      await copyCertificate(genDir, { crt: sourceCrt, key: sourceKey });
      this.#reloadPendingHash = sourceHash;
      logger.info(
        { sourceHash },
        'certSync: copied a new certificate onto asterisk-config'
      );
    }
    // `configChanged` rejecting here (a non-2xx from `core`) leaves `#reloadPendingHash` set, so
    // the next pass retries this call alone, without re-copying an already up-to-date file.
    await deps.coreClient.configChanged(['pjsip']);
    this.#reloadPendingHash = undefined;
    logger.info({ sourceHash }, 'certSync: triggered the pjsip reload');
    return 'ok';
  }

  /**
   * Whether to apply the change to `sourceHash` now: at once over no certificate or the
   * placeholder; otherwise once the gate opens, or at once when the current certificate expires
   * before the gate is next worth asking (the safety valve).
   */
  async #dueNow(
    sourceHash: string,
    currentCrt: Buffer | null
  ): Promise<boolean> {
    if (currentCrt === null || isSelfSigned(currentCrt)) {
      return true;
    }
    const deps = this.#deps;
    const now = (deps.now ?? (() => new Date()))();
    if (this.#pending?.sourceHash !== sourceHash) {
      this.#pending = {
        sourceHash,
        gate: createMaintenanceGate({
          db: deps.db,
          work: 'certSync',
          busy: async () => coreBusy(deps.coreClient)
        }),
        nextCheckMs: now.getTime()
      };
    }
    const pending = this.#pending;
    const verdict = await pending.gate.check(now);
    if (verdict.open) {
      return true;
    }
    const expiresAtMs = Date.parse(new X509Certificate(currentCrt).validTo);
    if (expiresAtMs < verdict.nextCheckAt.getTime()) {
      return true;
    }
    pending.nextCheckMs = verdict.nextCheckAt.getTime();
    return false;
  }
}

export type CertSyncScheduler = {
  status(): CertSyncStatus;
  /** Runs a pass right away (§6.4: the `POST /internal/certificate` notification), instead of
   * waiting for the next poll; the poll timer is reset around it. */
  notify(): void;
  stop(): void;
};

let running: CertSyncScheduler | undefined;

/**
 * Starts the process's certificate sync, which `startBackgroundJobs` does once at boot (§6.4
 * "The same sync runs at `api` start"): a pass at once, then on the drawn-in poll (`drawnIn.ts`),
 * which lands on a pending change's next gate check. A failed pass is logged, and the status
 * `/healthz` and `/metrics` read stays the last one known.
 */
export function startCertSync(deps: CertSyncDeps): CertSyncScheduler {
  const sync = new CertSync(deps);
  let status: CertSyncStatus = 'unknown';
  const schedule = scheduleDrawnIn({
    pass: async () => {
      status = await sync.run();
      return sync.nextCheckAt();
    },
    failed: error => {
      logger.error({ error }, 'certSync: the pass failed; the next retries');
    },
    now: deps.now
  });
  running = {
    status: () => status,
    notify: schedule.runNow,
    stop: schedule.stop
  };
  return running;
}

/** The running sync's status (§6.4, §7); `'unknown'` before its first pass, or with none started. */
export function certSyncStatus(): CertSyncStatus {
  return running?.status() ?? 'unknown';
}

/** Runs the running sync's pass at once; does nothing with none started. */
export function notifyCertSync(): void {
  running?.notify();
}
