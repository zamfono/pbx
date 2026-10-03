import type { Selectable } from 'kysely';

import type { DB } from '@zamfono/shared';

export type AuditLogRow = Selectable<DB['auditLog']>;

/** One field-level change, as `audit_log.changes_json` stores it (§5.7). */
export type ChangeEntry = { field: string; from: unknown; to: unknown };

/** Parses `changesJson` back into the `ChangeEntry` array it was written from. */
export function parseChanges(changesJson: string): ChangeEntry[] {
  return JSON.parse(changesJson) as ChangeEntry[];
}

/**
 * The table an entity kind's own row lives in, for the generic `deletedAt` revert and the
 * hard-purge existence check (§5.8, §5.9). A kind with no single addressable row — `settings`,
 * `parking`, `outboundRoute` (a whole-list replace), `trunk` order — is absent on purpose; see
 * `undo.ts`'s handling of an entity kind that is not in this table.
 */
export const ENTITY_TABLES: Partial<Record<string, keyof DB>> = {
  user: 'users',
  device: 'devices',
  ringGroup: 'ringGroups',
  menu: 'menus',
  did: 'dids',
  didBlock: 'didBlocks',
  trunk: 'trunks',
  webhook: 'webhooks',
  contact: 'contacts',
  audio: 'audioAssets',
  userGroup: 'userGroups',
  oooRule: 'oooRules',
  backupTarget: 'backupTargets',
  blockedNumber: 'blockedNumbers',
  openingHours: 'openingHours'
};

/** The wire shape of one `GET /audit` row (§5.7, §10.3). */
export type AuditEntryOut = {
  id: string;
  actorUserId: string;
  actorUserName: string;
  channel: string;
  clientId: string | null;
  clientName: string | null;
  operation: string;
  entityKind: string;
  entityId: string | null;
  changes: ChangeEntry[];
  undoable: boolean;
  revertsId: string | null;
  undoneAt: string | null;
  createdAt: string;
};

export function toAuditEntryOut(row: AuditLogRow): AuditEntryOut {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorUserName: row.actorUserName,
    channel: row.channel,
    clientId: row.clientId,
    clientName: row.clientName,
    operation: row.operation,
    entityKind: row.entityKind,
    entityId: row.entityId,
    changes: parseChanges(row.changesJson),
    undoable: row.undoable === 1,
    revertsId: row.revertsId,
    undoneAt: row.undoneAt,
    createdAt: row.createdAt
  };
}
