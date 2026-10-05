import {
  healthDocument,
  isDbOpen,
  pendingMigrations,
  type Db,
  type HealthCheck,
  type HealthChecks,
  type HealthDocument,
  type HealthStatus
} from '@zamfono/shared';

import type { CertSyncStatus } from './jobs/certSync.js';
import { countKeyRotationRemaining } from './jobs/keyRotation.js';
import { isRosterPending } from './ops/roster.js';
import { updateNews } from './ops/system/_state.js';
import { hasEmergencyTrunk } from './ops/trunks/_shared.js';
import { isPropagationPending } from './propagationPending.js';
import { isProfilePending } from './provisioning/profilePending.js';
import type { Keyring } from './secretbox.js';
import type { SipBanHelperState } from './sipBanList.js';

/** The certificate sync's state and the time of its last pass, `null` before the first (§6.4). */
export type CertificateSyncState = { state: CertSyncStatus; at: string | null };

/** What `apiHealth` needs to compute the document; a caller resolves each check its own way. */
export type ApiHealthDeps = {
  db: Db;
  migrationsDir: string;
  /** `core`'s own checks, `null` while `core` does not answer. */
  coreChecks: () => Promise<HealthChecks | null>;
  keyring: Keyring;
  certificateSync: CertificateSyncState;
  sipBanHelper: SipBanHelperState;
};

/** `certificate:sync`'s status per state of the sync (§10.3 "Health"). */
const CERTIFICATE_SYNC_STATUS: Record<CertSyncStatus, HealthStatus> = {
  ok: 'pass',
  unknown: 'warn',
  pending: 'warn',
  expiring: 'warn',
  missing: 'fail',
  failed: 'fail',
  expired: 'fail'
};

/** A check's entry: `status` while `bad`, else `pass`. */
function check(
  bad: boolean,
  status: HealthStatus,
  more: Omit<HealthCheck, 'status'> = {}
): [HealthCheck] {
  return [{ status: bad ? status : 'pass', ...more }];
}

/**
 * `database:status`: `fail` while the database is closed or a migration is pending, `api`'s
 * readiness too (`GET /readyz`, §6.3 "Health").
 */
export async function databaseCheck(
  db: Db,
  migrationsDir: string
): Promise<[HealthCheck]> {
  if (!(await isDbOpen(db))) {
    return [{ status: 'fail', output: 'closed' }];
  }
  const pending = await pendingMigrations(db, migrationsDir);
  return pending.length > 0
    ? [{ status: 'fail', output: 'migrationPending' }]
    : [{ status: 'pass' }];
}

/** `core:reachable`, joined by `core`'s own `core:*` checks while it answers. */
async function coreChecks(deps: ApiHealthDeps): Promise<HealthChecks> {
  const checks = await deps.coreChecks();
  if (!checks) {
    return { 'core:reachable': [{ status: 'fail' }] };
  }
  const own = Object.entries(checks).filter(([key]) => key.startsWith('core:'));
  return { 'core:reachable': [{ status: 'pass' }], ...Object.fromEntries(own) };
}

/** The checks read from the tables, which only a migrated database holds. */
async function tableChecks(db: Db, kr: Keyring): Promise<HealthChecks> {
  const remaining = await countKeyRotationRemaining(db, kr);
  return {
    'trunks:emergency': check(!(await hasEmergencyTrunk(db)), 'fail'),
    'secrets:keyRotation': check(remaining > 0, 'warn', {
      observedValue: remaining
    }),
    'config:propagation': check(await isPropagationPending(db), 'warn'),
    'ringotel:profile': check(await isProfilePending(db), 'warn'),
    'ringotel:roster': check(await isRosterPending(db), 'warn'),
    'update:automatic': check((await updateNews(db)).autoUpdateFailed, 'warn')
  };
}

/**
 * `GET /healthz`'s document (§6.3 "Health", §10.3 "Health"): one check per measurement and
 * nothing configurational or versioned, since it is public. The table checks are left out while
 * `database:status` fails, since `api` never runs a migration itself (§6.3 "Migrations"); a
 * query that fails on a migrated database rejects.
 */
export async function apiHealth(deps: ApiHealthDeps): Promise<HealthDocument> {
  const database = await databaseCheck(deps.db, deps.migrationsDir);
  const { state, at } = deps.certificateSync;
  const { running, heartbeat } = deps.sipBanHelper;
  return healthDocument({
    'database:status': database,
    ...(await coreChecks(deps)),
    'certificate:sync': [
      {
        status: CERTIFICATE_SYNC_STATUS[state],
        observedValue: state,
        ...(at === null ? {} : { time: at })
      }
    ],
    'sipBan:helper': check(
      !running,
      'fail',
      heartbeat === null ? {} : { time: heartbeat }
    ),
    ...(database[0].status === 'pass'
      ? await tableChecks(deps.db, deps.keyring)
      : {})
  });
}
