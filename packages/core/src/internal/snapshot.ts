/**
 * The config snapshot the ARI routing pipeline reads, and the cache that loads it (§3.1
 * "Config propagation").
 */
import type { Transaction } from 'kysely';

import type { Db, DB } from '@zamfono/shared';

import {
  parseDevice,
  parseForwardTarget,
  parseSettings,
  parseTrunk,
  parseUser,
  type ConfigRow,
  type ParsedDevice,
  type ParsedForwardTarget,
  type ParsedSettings,
  type ParsedTrunk,
  type ParsedUser
} from './snapshotRows.js';

// The tables the ARI routing pipeline reads; the tables `api` alone consults (auth, audit,
// webhooks, backups, contacts, BLF-key programming, mail templates) stay out of `core`'s cache.
// Each table's own `*Json` columns are decoded by `snapshotRows.ts`.
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
// here and its row types drop `deletedAt`: every snapshot row is live, and a deleted DID, user or
// blocklist entry would otherwise keep routing and keep blocking until the purge hard-deletes it.
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
type RawTableRows = { [K in ConfigTable]: ConfigRow<K>[] };

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
