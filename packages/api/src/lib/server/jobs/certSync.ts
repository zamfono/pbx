/**
 * TLS certificate sync (§6.4 "TLS certificates"): compares the `proxy` image's `cert_obtained`
 * hook's copy on `caddy-data` (`zamfono/cert.pem`/`privkey.pem`, images/proxy/zamfono-cert-hook)
 * with the copy on the `asterisk-config` volume, and on a change copies chain and key across —
 * at once for a fresh stack's self-signed placeholder or an expiring current certificate,
 * otherwise once the maintenance gate opens (`maintenanceWindow.ts`) — then propagates the
 * configuration (§3.1), which reloads PJSIP through `core`. Runs on a poll, and can be run early by `notifyCertSync()` when the
 * hook's own `POST /internal/certificate` reaches `api` (routes/internal/certificate/+server.ts).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';
import pino from 'pino';

import { MS_PER_DAY, type Db } from '@zamfono/shared';

import type { CoreClient } from '../coreClient.js';
import { sha256Hex } from '../hash.js';
import { onceConfigPropagated } from '../ops/afterCommit.js';
import { propagateConfig, runWhatWaited } from '../propagation.js';
import {
  copyCertificate,
  expiresBefore,
  findCaddyCert,
  isMatchingPair,
  isSelfSigned,
  TLS_CERT_FILENAME
} from './certSyncFiles.js';
import { scheduleDrawnIn } from './drawnIn.js';
import { coreBusy } from './maintenanceGiveUp.js';
import {
  createMaintenanceGate,
  type MaintenanceGate
} from './maintenanceWindow.js';

const logger = pino({ name: 'certSync' });

/** What a pass found (§6.4): no copy on `caddy-data`, or the state of the copy on `asterisk-config`. */
type PassStatus = 'expired' | 'expiring' | 'missing' | 'ok';

/**
 * The sync's state (§6.4): `'failed'` after a pass that could not read, check or copy the
 * certificate, `'pending'` while the reload of a copied certificate is owed (§3.1); only `'ok'`
 * is all clear.
 */
export type CertSyncStatus = PassStatus | 'failed' | 'pending' | 'unknown';

const EXPIRY_ALERT_DAYS = 14;
const EXPIRY_ALERT_MS = EXPIRY_ALERT_DAYS * MS_PER_DAY;

export type CertSyncDeps = {
  db: Db;
  coreClient: CoreClient;
  genDir?: string;
  caddyDataDir?: string;
  now?: () => Date;
};

/** A change waiting for its gate, and when that gate is next worth asking. */
type PendingChange = {
  sourceHash: string;
  gate: MaintenanceGate;
  nextCheckMs: number;
};

/**
 * The certificate sync over its deps, which keeps between its passes what it learnt: a change
 * waiting for its gate, and whether the reload of a copy is owed. Its owner runs one pass at a
 * time (`drawnIn.ts`).
 */
export class CertSync {
  readonly #deps: CertSyncDeps;
  // A source certificate's gate, which holds its resolved maintenance moment across passes,
  // until the change is applied or superseded.
  #pending: PendingChange | undefined;
  // Set while the propagation of a copied certificate is owed (§3.1), cleared by the first
  // propagation that succeeds after it.
  #reloadOwed = false;

  constructor(deps: CertSyncDeps) {
    this.#deps = deps;
  }

  /** Whether the reload of a copied certificate is owed (§6.4 `pending`). */
  reloadOwed(): boolean {
    return this.#reloadOwed;
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
   * upgrade gone wrong); once the pass is done, `'expired'` while the copy on `asterisk-config`
   * has expired, `'expiring'` while it expires within `EXPIRY_ALERT_MS`; `'ok'` otherwise,
   * whether nothing had changed, the change was applied now, or it was left for a later pass to
   * apply once due. A propagation of the copy that fails is owed (`reloadOwed`), not a failure.
   */
  async run(): Promise<PassStatus> {
    const genDir = this.#deps.genDir ?? env.ASTERISK_GEN_DIR;
    const currentCrtPath = path.join(genDir, 'tls', TLS_CERT_FILENAME);
    const status = await this.#sync(genDir, currentCrtPath);
    if (status !== 'ok') {
      return status;
    }
    const nowMs = (this.#deps.now ?? (() => new Date()))().getTime();
    const installed = await readFile(currentCrtPath).catch(() => null);
    if (expiresBefore(installed, nowMs)) {
      return 'expired';
    }
    return expiresBefore(installed, nowMs + EXPIRY_ALERT_MS)
      ? 'expiring'
      : 'ok';
  }

  async #sync(
    genDir: string,
    currentCrtPath: string
  ): Promise<'missing' | 'ok'> {
    const deps = this.#deps;
    const caddyDataDir = deps.caddyDataDir ?? env.CADDY_DATA_DIR;
    const source = await findCaddyCert(caddyDataDir);
    if (!source) {
      this.#pending = undefined;
      this.#reloadOwed = false;
      return 'missing';
    }
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
    if (upToDate) {
      this.#pending = undefined;
      return 'ok';
    }
    if (!(await this.#dueNow(sourceHash, currentCrt))) {
      return 'ok';
    }
    this.#pending = undefined;
    await copyCertificate(genDir, { crt: sourceCrt, key: sourceKey });
    logger.info(
      { sourceHash },
      'certSync: copied a new certificate onto asterisk-config'
    );
    await this.#reload(sourceHash);
    return 'ok';
  }

  /**
   * Propagates the copied certificate (§3.1): a propagation that fails is owed, and its retry or
   * any later success reloads every module, the certificate included.
   */
  async #reload(sourceHash: string): Promise<void> {
    const { db } = this.#deps;
    try {
      await propagateConfig(db, ['pjsip']);
    } catch (error) {
      this.#reloadOwed = true;
      logger.warn(
        { err: error, sourceHash },
        'certSync: the pjsip reload is owed until a config propagation succeeds'
      );
      await onceConfigPropagated(db, () => {
        this.#reloadOwed = false;
        return Promise.resolve();
      });
      return;
    }
    this.#reloadOwed = false;
    logger.info({ sourceHash }, 'certSync: triggered the pjsip reload');
    await runWhatWaited(db);
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
    if (expiresBefore(currentCrt, verdict.nextCheckAt.getTime())) {
      return true;
    }
    pending.nextCheckMs = verdict.nextCheckAt.getTime();
    return false;
  }
}

export type CertSyncScheduler = {
  status(): CertSyncStatus;
  /** When the last pass ended, in ISO 8601 UTC; `null` before the first. */
  lastPass(): string | null;
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
 * `/healthz` and `/metrics` read is `'failed'` until a pass succeeds; after one, `'pending'`
 * while the reload of its copy is owed.
 */
export function startCertSync(deps: CertSyncDeps): CertSyncScheduler {
  const sync = new CertSync(deps);
  let status: PassStatus | 'failed' | 'unknown' = 'unknown';
  let lastPass: string | null = null;
  const passed = (): void => {
    lastPass = (deps.now ?? (() => new Date()))().toISOString();
  };
  const schedule = scheduleDrawnIn({
    pass: async () => {
      status = await sync.run();
      passed();
      return sync.nextCheckAt();
    },
    failed: error => {
      status = 'failed';
      passed();
      logger.error(
        { err: error },
        'certSync: the pass failed; the next retries'
      );
    },
    now: deps.now
  });
  running = {
    status: () =>
      status !== 'failed' && sync.reloadOwed() ? 'pending' : status,
    lastPass: () => lastPass,
    notify: schedule.runNow,
    stop: schedule.stop
  };
  return running;
}

/** The running sync's status (§6.4, §7); `'unknown'` before its first pass, or with none started. */
export function certSyncStatus(): CertSyncStatus {
  return running?.status() ?? 'unknown';
}

/** When the running sync's last pass ended (§10.3 "Health"); `null` before its first, or with none started. */
export function certSyncLastPass(): string | null {
  return running?.lastPass() ?? null;
}

/** Runs the running sync's pass at once; does nothing with none started. */
export function notifyCertSync(): void {
  running?.notify();
}
