import { sql } from 'kysely';

import { isDbOpen, pendingMigrations, type Db } from '@zamfono/shared';

import { ENC_COLUMNS } from './jobs/keyRotation.js';
import { loadUpdateState } from './ops/system/_state.js';
import { hasEmergencyTrunk } from './ops/trunks/_shared.js';
import { isProfilePending } from './provisioning/profilePending.js';
import type { Keyring } from './secretbox.js';

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;

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
   * The newer release the stack cannot take on its own because it is breaking, to be installed
   * with `update.sh` on the host; `null` while there is none (§6.3 "Updates").
   */
  breakingUpdateAvailable: string | null;
  /** The release the last automatic update failed to install, until an update succeeds (§6.3). */
  autoUpdateFailed: string | null;
};

/** What `apiHealth` needs to compute a body; a caller resolves each check its own way. */
export type ApiHealthDeps = {
  db: Db;
  checkCore: () => Promise<CoreReachability>;
  keyRotationRemaining: number;
  certificateSync: 'ok' | 'missing' | 'unknown';
};

/**
 * Rows in `table.column` whose blob is not on the keyring's current key generation. Selects
 * only the version byte (`substr`), never the ciphertext, since `GET /healthz` is public and
 * unauthenticated (§10.3 Health row) and must not pull decryptable secrets into memory.
 */
async function countRemainingInColumn(
  db: Db,
  kr: Keyring,
  table: string,
  column: string
): Promise<number> {
  try {
    const { rows } = await sql<{
      versionByte: Buffer | null;
    }>`SELECT substr(${sql.ref(column)}, 1, 1) AS versionByte FROM ${sql.table(table)} WHERE ${sql.ref(column)} IS NOT NULL`.execute(
      db
    );
    return rows.filter(
      row =>
        row.versionByte === null ||
        row.versionByte.length === 0 ||
        row.versionByte.readUInt8(0) !== kr.current.generation
    ).length;
  } catch {
    // The table does not exist yet, e.g. before the first migration; `migrated` already
    // reports that, so this contributes nothing rather than failing the whole health check.
    return 0;
  }
}

/**
 * Rows still encrypted under a key generation other than the keyring's current one (§5.4): what
 * the boot-time re-encryption sweep (`jobs/keyRotation.ts`) has not brought forward, whether it
 * has not run yet or the blob is unreadable under any key the keyring holds. Read-only, so a
 * `/healthz` request never itself re-encrypts anything.
 */
export async function countKeyRotationRemaining(
  db: Db,
  kr: Keyring
): Promise<number> {
  let remaining = 0;
  for (const [table, columns] of Object.entries(ENC_COLUMNS)) {
    for (const column of columns) {
      // eslint-disable-next-line no-await-in-loop -- a handful of columns; nothing here benefits from parallelizing over one sqlite connection
      remaining += await countRemainingInColumn(db, kr, table, column);
    }
  }
  return remaining;
}

/** `pendingMigrations`, or `null` when the migrations directory itself cannot be read. */
async function pendingMigrationsOrNull(db: Db): Promise<string[] | null> {
  try {
    return await pendingMigrations(db);
  } catch {
    return null;
  }
}

/**
 * `settings.smtp_host` set means a relay is configured (§11.4); no row yet — before first
 * boot has seeded one, or while a migration is still pending — means it is not.
 */
async function mailConfigured(db: Db): Promise<'configured' | 'notConfigured'> {
  try {
    const settings = await db
      .selectFrom('settings')
      .select('smtpHost')
      .where('id', '=', 1)
      .executeTakeFirst();
    return settings?.smtpHost ? 'configured' : 'notConfigured';
  } catch {
    return 'notConfigured';
  }
}

/**
 * Whether a live trunk has `trunks.emergency` set (§9.4 "Emergency trunks"): without one,
 * emergency calls fail (§10.1). A database that cannot answer — no `trunks` table yet, before
 * the first migration — reports none; `migrated` already says why.
 */
async function emergencyTrunkPresent(db: Db): Promise<boolean> {
  try {
    return await hasEmergencyTrunk(db);
  } catch {
    return false;
  }
}

/** `isProfilePending`, or `false` for a database without the column or row yet. */
async function profilePending(db: Db): Promise<boolean> {
  try {
    return await isProfilePending(db);
  } catch {
    return false;
  }
}

/** The update fields of `update_state`, both `null` for a database without the table yet. */
async function updateFields(
  db: Db
): Promise<Pick<ApiHealth, 'autoUpdateFailed' | 'breakingUpdateAvailable'>> {
  try {
    const row = await loadUpdateState(db);
    return {
      breakingUpdateAvailable: row?.breakingVersion ?? null,
      autoUpdateFailed: row?.autoFailedVersion ?? null
    };
  } catch {
    return { breakingUpdateAvailable: null, autoUpdateFailed: null };
  }
}

/**
 * `api`'s own liveness plus the fields a client cannot otherwise observe (§6.3 "Health"):
 * `ok` is true only while the database is open and holds no pending migration, since `api`
 * never runs one itself (§6.3 "Migrations").
 */
export async function apiHealth(deps: ApiHealthDeps): Promise<ApiHealth> {
  const dbOpen = await isDbOpen(deps.db);
  const pending = dbOpen ? await pendingMigrationsOrNull(deps.db) : [];
  const migrated = dbOpen && pending !== null && pending.length === 0;
  const mail = dbOpen ? await mailConfigured(deps.db) : 'notConfigured';
  const emergencyTrunk = dbOpen && (await emergencyTrunkPresent(deps.db));
  const ringotelProfilePending = dbOpen && (await profilePending(deps.db));
  const updates = dbOpen
    ? await updateFields(deps.db)
    : { breakingUpdateAvailable: null, autoUpdateFailed: null };
  const core = await deps.checkCore();
  return {
    ok: dbOpen && migrated,
    db: dbOpen,
    migrated,
    core,
    mail,
    keyRotationRemaining: deps.keyRotationRemaining,
    certificateSync: deps.certificateSync,
    emergencyTrunk,
    ringotelProfilePending,
    ...updates
  };
}

/** The `/healthz` HTTP status: `200` iff `ApiHealth.ok`, else `503` (§6.3 "Health"). */
export function healthStatus(health: ApiHealth): number {
  return health.ok ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE;
}
