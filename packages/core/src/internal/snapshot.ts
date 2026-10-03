/**
 * The config snapshot the ARI routing pipeline reads, and the cache that loads it (§3.1
 * "Config propagation").
 */
import type { Selectable, Transaction } from 'kysely';

import {
  featureCodesSchema,
  type Db,
  type DB,
  type FeatureCodes,
  type SipHeaderTemplate
} from '@zamfono/shared';

// The tables the ARI routing pipeline reads; the tables `api` alone consults (auth, audit,
// webhooks, backups, contacts, BLF-key programming, mail templates) stay out of `core`'s cache.
// Each table's own `*Json` columns (`findMeJson`, `codecsJson`, …) are parsed below, into the
// same-named field without the `Json` suffix, so the pipeline never re-parses them.
const CONFIG_TABLES = [
  'users',
  'devices',
  'dids',
  'didBlocks',
  'blockedNumbers',
  'ringGroups',
  'ringGroupMembers',
  'ringGroupForwardRules',
  'userGroups',
  'userGroupUsers',
  'userGroupGroups',
  'extensions',
  'forwardTargets',
  'userForwardRules',
  'openingHours',
  'openingHoursIntervals',
  'oooRules',
  'menus',
  'menuTargets',
  'trunks',
  'trunkHosts',
  'outboundRoutes',
  'outboundRouteUsers',
  'outboundRouteUserGroups',
  'outboundRouteNumbers',
  'audioAssets'
] as const;

// The subset of CONFIG_TABLES carrying `deleted_at` (§11.1 "Soft delete"). A soft-deleted row
// stays readable for the undo window (§5.8), so the snapshot the pipeline routes on excludes it
// here: nothing downstream filters, and a deleted DID, user or blocklist entry would otherwise
// keep routing and keep blocking until the purge hard-deletes it days later.
const SOFT_DELETED_TABLES = new Set<string>([
  'users',
  'devices',
  'dids',
  'didBlocks',
  'blockedNumbers',
  'ringGroups',
  'userGroups',
  'openingHours',
  'oooRules',
  'menus',
  'trunks',
  'outboundRoutes',
  'audioAssets'
]);

type ConfigTable = (typeof CONFIG_TABLES)[number];
type RawTableRows = { [K in ConfigTable]: Selectable<DB[K]>[] };

type ParsedUser = Omit<Selectable<DB['users']>, 'findMeJson'> & {
  findMe: { number: string; delayS: number }[] | null;
};
type ParsedDevice = Omit<Selectable<DB['devices']>, 'allowedIpsJson'> & {
  allowedIps: string[] | null;
};
type ParsedTrunk = Omit<Selectable<DB['trunks']>, 'codecsJson'> & {
  codecs: string[] | null;
};
type ParsedForwardTarget = Omit<
  Selectable<DB['forwardTargets']>,
  'sipHeadersJson'
> & {
  sipHeaders: SipHeaderTemplate[] | null;
};
type ParsedSettings = Omit<
  Selectable<DB['settings']>,
  'codecsJson' | 'emergencyNumbersJson' | 'featureCodesJson'
> & {
  codecs: string[];
  emergencyNumbers: string[];
  featureCodes: FeatureCodes;
};

type TableRows = Omit<
  RawTableRows,
  'users' | 'devices' | 'trunks' | 'forwardTargets'
> & {
  users: ParsedUser[];
  devices: ParsedDevice[];
  trunks: ParsedTrunk[];
  forwardTargets: ParsedForwardTarget[];
};

/** Every config table the routing pipeline reads, loaded in one transaction (§3.1). */
export type Snapshot = TableRows & { settings: ParsedSettings };

/** The live user `id`; `null` for none, or a user deleted or gone. */
export function userById(
  snapshot: Snapshot,
  id: string | null
): Snapshot['users'][number] | null {
  return id === null
    ? null
    : (snapshot.users.find(row => row.id === id) ?? null);
}

/** Parses one `*Json` column; `null` passes through unchanged. */
function parseNullableJson(column: string, value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `config snapshot: invalid JSON in ${column}: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

function parseUser(row: Selectable<DB['users']>): ParsedUser {
  const { findMeJson, ...rest } = row;
  return {
    ...rest,
    findMe: parseNullableJson('users.findMeJson', findMeJson) as
      { number: string; delayS: number }[] | null
  };
}

function parseDevice(row: Selectable<DB['devices']>): ParsedDevice {
  const { allowedIpsJson, ...rest } = row;
  return {
    ...rest,
    allowedIps: parseNullableJson('devices.allowedIpsJson', allowedIpsJson) as
      string[] | null
  };
}

function parseTrunk(row: Selectable<DB['trunks']>): ParsedTrunk {
  const { codecsJson, ...rest } = row;
  return {
    ...rest,
    codecs: parseNullableJson('trunks.codecsJson', codecsJson) as
      string[] | null
  };
}

function parseForwardTarget(
  row: Selectable<DB['forwardTargets']>
): ParsedForwardTarget {
  const { sipHeadersJson, ...rest } = row;
  return {
    ...rest,
    sipHeaders: parseNullableJson(
      'forwardTargets.sipHeadersJson',
      sipHeadersJson
    ) as SipHeaderTemplate[] | null
  };
}

function parseSettings(row: Selectable<DB['settings']>): ParsedSettings {
  const { codecsJson, emergencyNumbersJson, featureCodesJson, ...rest } = row;
  return {
    ...rest,
    codecs: parseNullableJson('settings.codecsJson', codecsJson) as string[],
    emergencyNumbers: parseNullableJson(
      'settings.emergencyNumbersJson',
      emergencyNumbersJson
    ) as string[],
    featureCodes: featureCodesSchema.parse(
      parseNullableJson('settings.featureCodesJson', featureCodesJson)
    )
  };
}

async function loadSnapshot(trx: Transaction<DB>): Promise<Snapshot> {
  const rows = await Promise.all(
    CONFIG_TABLES.map(table => trx.selectFrom(table).selectAll().execute())
  );
  // Filtered here rather than in each query: the column exists on only some of these tables, and
  // a per-table predicate is not expressible over the union `CONFIG_TABLES` resolves to. Config
  // tables are small enough that the whole snapshot is one read either way.
  const tables = Object.fromEntries(
    CONFIG_TABLES.map((table, index) => [
      table,
      SOFT_DELETED_TABLES.has(table)
        ? (rows[index] ?? []).filter(
            row => (row as { deletedAt?: string | null }).deletedAt === null
          )
        : rows[index]
    ])
  ) as unknown as RawTableRows;
  const settingsRow = await trx
    .selectFrom('settings')
    .selectAll()
    .executeTakeFirstOrThrow();
  return {
    ...tables,
    users: tables.users.map(parseUser),
    devices: tables.devices.map(parseDevice),
    trunks: tables.trunks.map(parseTrunk),
    forwardTargets: tables.forwardTargets.map(parseForwardTarget),
    settings: parseSettings(settingsRow)
  };
}

/** Caches one config `Snapshot`; `invalidate()` forces the next `get()` to reload it (§3.1). */
export class ConfigCache {
  private readonly db: Db;
  private snapshot: Promise<Snapshot> | null = null;
  private readonly invalidateListeners = new Set<() => void>();

  constructor(db: Db) {
    this.db = db;
  }

  get(): Promise<Snapshot> {
    this.snapshot ??= this.db
      .transaction()
      .execute(trx => loadSnapshot(trx))
      .catch((error: unknown) => {
        this.snapshot = null;
        throw error;
      });
    return this.snapshot;
  }

  invalidate(): void {
    this.snapshot = null;
    for (const listener of this.invalidateListeners) {
      listener();
    }
  }

  /** Calls `listener` after every `invalidate()`, until the returned function unsubscribes it. */
  onInvalidate(listener: () => void): () => void {
    this.invalidateListeners.add(listener);
    return () => {
      this.invalidateListeners.delete(listener);
    };
  }
}
