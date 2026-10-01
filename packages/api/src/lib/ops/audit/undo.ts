import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { OUTCOME_OPERATIONS } from '../outcomeLog.js';
import { registry } from '../registry.js';
import { Conflict, defineOperation, OpError, type Context } from '../types.js';
import { isTenantListOperation, revertTenantList } from './_listReverts.js';
import { ENTITY_TABLES, parseChanges, type ChangeEntry } from './_shared.js';
import { refuseUniqueViolation } from './_uniqueViolation.js';
import { revertCreation, revertEntry } from './revert.js';

const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const CREATE_SUFFIX = '.create';

/**
 * One `audit_log` row as `loadUndoableEntry` resolves it; `entityId` is `null` only for a
 * tenant-wide list replace, whose entity is the list as a whole (`isTenantListOperation`).
 */
type UndoableEntry = {
  id: string;
  operation: string;
  entityKind: string;
  entityId: string | null;
  changesJson: string;
};

/**
 * The `audit_log` row `id` names, or a refusal (§5.8): not found, already undone, `undoable 0`,
 * or an entry with no entity id that is not a tenant-wide list replace, so nothing to revert.
 */
async function loadUndoableEntry(
  ctx: Context,
  id: string
): Promise<UndoableEntry> {
  const original = await ctx.db
    .selectFrom('auditLog')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!original) {
    throw new OpError(STATUS_NOT_FOUND, `audit entry '${id}' not found`);
  }
  if (original.undoneAt !== null) {
    throw new OpError(STATUS_CONFLICT, 'audit entry has already been undone');
  }
  if (original.undoable !== 1) {
    throw new OpError(STATUS_CONFLICT, 'audit entry is not undoable');
  }
  if (
    original.entityId === null &&
    !isTenantListOperation(original.operation)
  ) {
    throw new OpError(
      STATUS_CONFLICT,
      `audit.undo: entity kind '${original.entityKind}' has no single row to revert`
    );
  }
  return {
    id: original.id,
    operation: original.operation,
    entityKind: original.entityKind,
    entityId: original.entityId,
    changesJson: original.changesJson
  };
}

/**
 * The later, still-live changes for the same entity that keep `id` from being undone (§5.8).
 * Undone entries and undo entries do not count, and neither does an operation marked
 * `pureAction`, nor an outcome row (`OUTCOME_OPERATIONS`): a test send, a credential reveal or
 * what Ringotel answered to a push changes nothing an undo would build on. Every
 * other entry does, undoable or not, since a secret rotation or a hard delete is still a change.
 */
async function laterLiveChanges(
  ctx: Context,
  entityKind: string,
  entityId: string | null,
  id: string
): Promise<{ id: string; operation: string }[]> {
  const later = await ctx.db
    .selectFrom('auditLog')
    .select(['id', 'operation'])
    .where('entityKind', '=', entityKind)
    .where('entityId', entityId === null ? 'is' : '=', entityId)
    .where('id', '>', id)
    .where('undoneAt', 'is', null)
    .where('operation', '!=', 'audit.undo')
    .execute();
  return later.filter(
    row =>
      registry.get(row.operation)?.pureAction !== true &&
      !OUTCOME_OPERATIONS.has(row.operation)
  );
}

/** Refuses with a 409 naming any later live change for `entry`'s entity (§5.8). */
async function assertNoLaterChange(
  ctx: Context,
  entry: UndoableEntry
): Promise<void> {
  const later = await laterLiveChanges(
    ctx,
    entry.entityKind,
    entry.entityId,
    entry.id
  );
  if (later.length > 0) {
    throw new Conflict(
      'a later change exists for this entity',
      later.map(row => ({ kind: 'auditLog', id: row.id, label: row.operation }))
    );
  }
}

/** Refuses with a 409 while reverting a deletion whose row has since been hard-purged (§5.8). */
async function assertRowNotPurged(
  ctx: Context,
  entry: UndoableEntry & { entityId: string },
  changes: ChangeEntry[]
): Promise<void> {
  const revertsADeletion = changes.some(change => change.field === 'deletedAt');
  if (!revertsADeletion) {
    return;
  }
  const table = ENTITY_TABLES[entry.entityKind];
  if (!table) {
    throw new OpError(
      STATUS_CONFLICT,
      `audit.undo: entity kind '${entry.entityKind}' has no soft-delete table`
    );
  }
  const stillThere = await ctx.db
    .selectFrom(table)
    .select('id')
    .where('id', '=', entry.entityId)
    .executeTakeFirst();
  if (!stillThere) {
    throw new Conflict('the reverted row has been purged', [
      { kind: entry.entityKind, id: entry.entityId, label: entry.entityId }
    ]);
  }
}

/** Appends the `audit.undo` row itself: channel `undo` and `revertsId` are its own concern, which
 * is why this operation opts out of the runner's generic audit write (§5.8). */
async function appendUndoEntry(
  ctx: Context,
  reverted: UndoableEntry,
  reverseChanges: ChangeEntry[]
): Promise<void> {
  await ctx.db
    .insertInto('auditLog')
    .values({
      id: newId(),
      actorUserId: ctx.actor.id,
      actorUserName: ctx.actor.name,
      channel: 'undo',
      // NULL for undo whoever calls it, as for UI sessions and jobs (§11.2 `audit_log`).
      clientId: null,
      clientName: null,
      operation: 'audit.undo',
      entityKind: reverted.entityKind,
      entityId: reverted.entityId,
      changesJson: JSON.stringify(reverseChanges),
      undoable: 0,
      revertsId: reverted.id,
      undoneAt: null,
      createdAt: ctx.now
    })
    .execute();
}

/**
 * `POST /audit/{id}/undo` (§5.8): reverts one `audit_log` entry by writing its `changes_json`
 * `from` values back, through the reverted entity's own operation, and appends the entry's own
 * `audit.undo` row. Never asks confirmation (§10.3).
 */
export const undo = defineOperation({
  name: 'audit.undo',
  description:
    "Reverts one audit entry by replaying its recorded 'from' values; refused with 409 while a later live change to the same entity exists (zamfono.help undo).",
  input: z
    .object({
      id: z.string().describe('The audit entry to revert, from audit.list.')
    })
    .strict(),
  minRole: 'admin',
  audit: false,
  run: async (ctx, input) => {
    const entry = await loadUndoableEntry(ctx, input.id);
    await assertNoLaterChange(ctx, entry);
    const changes = parseChanges(entry.changesJson);
    const { entityId } = entry;
    await refuseUniqueViolation(async () => {
      if (entityId === null) {
        await revertTenantList(ctx, entry.operation, changes);
      } else if (entry.operation.endsWith(CREATE_SUFFIX)) {
        await revertCreation(ctx, entry.entityKind, entityId);
      } else {
        const rowEntry = { ...entry, entityId };
        await assertRowNotPurged(ctx, rowEntry, changes);
        await revertEntry(ctx, rowEntry, changes);
      }
    });
    await ctx.db
      .updateTable('auditLog')
      .set({ undoneAt: ctx.now })
      .where('id', '=', entry.id)
      .execute();
    const reverseChanges: ChangeEntry[] = changes.map(change => ({
      field: change.field,
      from: change.to,
      to: change.from
    }));
    await appendUndoEntry(ctx, entry, reverseChanges);
    return { id: entry.id };
  }
});
