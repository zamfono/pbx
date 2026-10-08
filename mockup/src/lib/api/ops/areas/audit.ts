/**
 * The audit log (`ops/audit/`, §5.7, §5.8): `audit.list` with the API's filters, and `audit.undo`,
 * which reverts one entry. Undoing a user's soft delete that brings back an admin or owner is
 * owner-only.
 *
 * Entries the seed wrote carry no recorded writes; their undo replays the `from` values of the
 * diff onto the entity, as the API's revert writes them back through the entity's operation.
 */
import { conflict } from '../../errors';
import type {
  AuditChannel,
  AuditEntry,
  Db,
  RevertStep,
  RowTable
} from '../../types';
import { defineOp, undoEntry, type Ctx } from '../core';

export type AuditState = 'live' | 'undone' | 'all';
export type AuditEntryWire = Omit<AuditEntry, 'revert' | 'pure'>;

export type AuditListInput = {
  entityKind?: string;
  entityId?: string;
  actorUserId?: string;
  channel?: AuditChannel;
  clientId?: string;
  operation?: string;
  /** ISO instant or date: entries at or after it. */
  from?: string;
  /** ISO instant, or a date meaning before the end of that day. */
  to?: string;
  state?: AuditState;
  limit?: number;
  cursor?: string;
};

/** The table each entity kind's row lives in (`ENTITY_TABLES`). */
const ENTITY_TABLES: Partial<Record<string, RowTable>> = {
  user: 'users',
  device: 'devices',
  ringGroup: 'ringGroups',
  menu: 'menus',
  did: 'dids',
  didBlock: 'didBlocks',
  trunk: 'trunks',
  webhook: 'webhooks',
  contact: 'contacts',
  audio: 'audio',
  userGroup: 'userGroups',
  oooRule: 'oooRules',
  backupTarget: 'backupTargets',
  blockedNumber: 'blockedNumbers',
  sipAllowlistEntry: 'sipAllowlist',
  openingHours: 'openingHours',
  personalAccessToken: 'personalAccessTokens'
};

const toWire = ({
  revert: _revert,
  pure: _pure,
  ...entry
}: AuditEntry): AuditEntryWire => entry;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function endOf(value: string): string {
  if (!DATE_ONLY.test(value)) {
    return value;
  }
  const next = new Date(`${value}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

const startOf = (value: string): string =>
  DATE_ONLY.test(value) ? new Date(`${value}T00:00:00`).toISOString() : value;

defineOp<AuditListInput, { items: AuditEntryWire[]; nextCursor: null }>({
  name: 'audit.list',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    const state = input.state ?? 'live';
    const from = input.from === undefined ? undefined : startOf(input.from);
    const to = input.to === undefined ? undefined : endOf(input.to);
    const items = ctx.db.audit.filter(
      entry =>
        (input.entityKind === undefined ||
          entry.entityKind === input.entityKind) &&
        (input.entityId === undefined || entry.entityId === input.entityId) &&
        (input.actorUserId === undefined ||
          entry.actorUserId === input.actorUserId) &&
        (input.channel === undefined || entry.channel === input.channel) &&
        (input.clientId === undefined || entry.clientId === input.clientId) &&
        (input.operation === undefined ||
          entry.operation === input.operation) &&
        (from === undefined || entry.createdAt >= from) &&
        (to === undefined || entry.createdAt < to) &&
        (state === 'all' ||
          (state === 'live'
            ? entry.undoneAt === null
            : entry.undoneAt !== null))
    );
    return {
      items: items
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toWire),
      nextCursor: null
    };
  }
});

/** The writes an entry without recorded ones stands for, rebuilt from its diff. */
function replaySteps(db: Db, entry: AuditEntry): RevertStep[] {
  if (entry.changes.length === 0) {
    return [];
  }
  if (entry.entityKind === 'settings') {
    const before: Record<string, unknown> = { ...db.settings };
    for (const change of entry.changes) {
      if (change.field in before) {
        before[change.field] = change.from;
      }
    }
    return [{ kind: 'root', table: 'settings', before }];
  }
  const table = ENTITY_TABLES[entry.entityKind];
  if (table === undefined || entry.entityId === null) {
    throw conflict(
      'undoNoEntity',
      `audit.undo: entity kind '${entry.entityKind}' has no single row to revert`
    );
  }
  const row = (db[table] as { id: string }[]).find(
    candidate => candidate.id === entry.entityId
  );
  if (row === undefined) {
    throw conflict('undoPurged', 'the reverted row has been purged', [
      { kind: entry.entityKind, id: entry.entityId, label: entry.entityId }
    ]);
  }
  const creation =
    entry.operation.endsWith('.create') &&
    entry.changes.every(change => change.from === null);
  if (creation) {
    return [{ kind: 'row', table, id: entry.entityId, before: null }];
  }
  const before: Record<string, unknown> = { ...row };
  for (const change of entry.changes) {
    before[change.field] = change.from;
  }
  return [{ kind: 'row', table, id: entry.entityId, before }];
}

/** Whether undoing `id` restores an admin or owner a `users.delete` removed (`restoresAnAdmin`). */
function restoresAnAdmin(ctx: Ctx, input: { id: string }): boolean {
  const entry = ctx.db.audit.find(candidate => candidate.id === input.id);
  if (
    entry === undefined ||
    entry.operation !== 'users.delete' ||
    entry.entityId === null
  ) {
    return false;
  }
  const user = ctx.db.users.find(candidate => candidate.id === entry.entityId);
  return user !== undefined && user.role !== 'user';
}

defineOp<{ id: string }, { id: string }>({
  name: 'audit.undo',
  minRole: 'admin',
  ownerOnly: restoresAnAdmin,
  run: (ctx, input) => {
    const entry = ctx.db.audit.find(candidate => candidate.id === input.id);
    if (
      entry !== undefined &&
      entry.undoable &&
      entry.undoneAt === null &&
      (entry.revert ?? []).length === 0
    ) {
      entry.revert = replaySteps(ctx.db, entry);
    }
    undoEntry(ctx, input.id);
    return { id: input.id };
  }
});
