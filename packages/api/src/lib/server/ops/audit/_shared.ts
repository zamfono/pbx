import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  AUDIT_CHANNELS,
  changeEntrySchema,
  changesColumn,
  type DB
} from '@zamfono/shared';

export type AuditLogRow = Selectable<DB['auditLog']>;

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
export const auditEntryOut = z.object({
  id: z.string(),
  actorUserId: z.string(),
  actorUserName: z.string(),
  channel: z.enum(AUDIT_CHANNELS),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  operation: z.string(),
  entityKind: z.string(),
  entityId: z.string().nullable(),
  changes: z.array(changeEntrySchema),
  undoable: z.boolean(),
  revertsId: z.string().nullable(),
  undoneAt: z.string().nullable(),
  createdAt: z.string()
});
export type AuditEntryOut = z.infer<typeof auditEntryOut>;

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
    changes: changesColumn.decode(row.changesJson),
    undoable: row.undoable === 1,
    revertsId: row.revertsId,
    undoneAt: row.undoneAt,
    createdAt: row.createdAt
  };
}
