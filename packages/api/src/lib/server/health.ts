import {
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  isDbOpen,
  pendingMigrations,
  type Db
} from '@zamfono/shared';

import { countKeyRotationRemaining } from './jobs/keyRotation.js';
import { updateNews } from './ops/system/_state.js';
import { hasEmergencyTrunk } from './ops/trunks/_shared.js';
import { isPropagationPending } from './propagationPending.js';
import { isProfilePending } from './provisioning/profilePending.js';
import type { Keyring } from './secretbox.js';

/** `core`'s own reachability and ARI connection, as seen from `api` (§6.3 "Health"). */
export type CoreReachability = { reachable: boolean; ari: boolean };

/**
 * `GET /healthz`'s body (§6.3 "Health", §10.3 Health row): the HTTP status reflects only
 * `ok`, so every other field is informational.
 */
export type ApiHealth = {
  ok: boolean;
  db: boolean;
  migrated: boolean;
  core: CoreReachability;
  mail: 'configured' | 'notConfigured';
  keyRotationRemaining: number;
  certificateSync: 'ok' | 'missing' | 'unknown';
  /** Whether a live trunk carries emergency calls (§9.4 "Emergency trunks"). */
  emergencyTrunk: boolean;
  /**
   * Whether a tenant profile change, the emergency numbers among them, has not reached Ringotel
   * yet (§10.4 "Tenant profile push").
   */
  ringotelProfilePending: boolean;
  /**
   * Whether a config propagation failed and none has succeeded since, so Asterisk may run on an
   * older configuration than the one stored (§3.1 "Config propagation").
   */
  configPropagationPending: boolean;
  /**
   * Whether an automatic update failed, from its first failed attempt until an update succeeds;
   * `false` without an updater, which automatic updates need (§6.3 "Automatic updates"). What
   * else is known of releases is `system.info`'s, which needs a login, and `/metrics`'.
   */
  autoUpdateFailed: boolean;
};

/** What `apiHealth` needs to compute a body; a caller resolves each check its own way. */
export type ApiHealthDeps = {
  db: Db;
  migrationsDir: string;
  checkCore: () => Promise<CoreReachability>;
  keyring: Keyring;
  certificateSync: 'ok' | 'missing' | 'unknown';
};

/** `settings.smtp_host` set means a relay is configured (§11.4). */
async function mailConfigured(db: Db): Promise<'configured' | 'notConfigured'> {
  const settings = await db
    .selectFrom('settings')
    .select('smtpHost')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return settings.smtpHost ? 'configured' : 'notConfigured';
}

/** The body fields read from the tables, which only a migrated database holds. */
type TableChecks = Pick<
  ApiHealth,
  | 'mail'
  | 'keyRotationRemaining'
  | 'emergencyTrunk'
  | 'ringotelProfilePending'
  | 'configPropagationPending'
  | 'autoUpdateFailed'
>;

/** What `apiHealth` reports for the table checks while `migrated` is false. */
const UNMIGRATED_CHECKS: TableChecks = {
  mail: 'notConfigured',
  keyRotationRemaining: 0,
  emergencyTrunk: false,
  ringotelProfilePending: false,
  configPropagationPending: false,
  autoUpdateFailed: false
};

async function tableChecks(db: Db, kr: Keyring): Promise<TableChecks> {
  return {
    mail: await mailConfigured(db),
    keyRotationRemaining: await countKeyRotationRemaining(db, kr),
    emergencyTrunk: await hasEmergencyTrunk(db),
    ringotelProfilePending: await isProfilePending(db),
    configPropagationPending: await isPropagationPending(db),
    autoUpdateFailed: (await updateNews(db)).autoUpdateFailed
  };
}

/**
 * `api`'s own liveness plus the fields a client cannot otherwise observe (§6.3 "Health"):
 * `ok` is true only while the database is open and holds no pending migration, since `api`
 * never runs one itself (§6.3 "Migrations"). The table checks run only then; a query that
 * fails on a migrated database rejects.
 */
export async function apiHealth(deps: ApiHealthDeps): Promise<ApiHealth> {
  const dbOpen = await isDbOpen(deps.db);
  const migrated =
    dbOpen &&
    (await pendingMigrations(deps.db, deps.migrationsDir)).length === 0;
  const checks = migrated
    ? await tableChecks(deps.db, deps.keyring)
    : UNMIGRATED_CHECKS;
  return {
    ok: migrated,
    db: dbOpen,
    migrated,
    core: await deps.checkCore(),
    certificateSync: deps.certificateSync,
    ...checks
  };
}

/** The `/healthz` HTTP status: `200` iff `ApiHealth.ok`, else `503` (§6.3 "Health"). */
export function healthStatus(health: ApiHealth): number {
  return health.ok ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE;
}
