import { z } from 'zod';

import {
  changesColumn,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  type ChangeEntry
} from '@zamfono/shared';

import { recordRevert } from '../audit.js';
import { OUTCOME_OPERATIONS } from '../outcomeLog.js';
import { registry } from '../registry.js';
import { idOutput } from '../rows.js';
import { Conflict, defineOperation, OpError, type Context } from '../types.js';
import { isTenantListOperation, revertTenantList } from './_listReverts.js';
import { ENTITY_TABLES } from './_shared.js';
import { refuseUniqueViolation } from './_uniqueViolation.js';
import { revertEntry } from './revert.js';

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
    throw new OpError(HTTP_NOT_FOUND, `audit entry '${id}' not found`);
  }
  if (original.undoneAt !== null) {
    throw new OpError(HTTP_CONFLICT, 'audit entry has already been undone');
  }
  if (original.undoable !== 1) {
    throw new OpError(HTTP_CONFLICT, 'audit entry is not undoable');
  }
  if (
    original.entityId === null &&
    !isTenantListOperation(original.operation)
  ) {
    throw new OpError(
      HTTP_CONFLICT,
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
      HTTP_CONFLICT,
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

/**
 * `POST /audit/{id}/undo` (§5.8): reverts one `audit_log` entry by writing its `changes_json`
 * `from` values back, through the reverted entity's own operation; its own entry is the reverse
 * of the reverted one (`recordRevert`). Never asks confirmation (§10.3).
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
  output: idOutput,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  run: async (ctx, input) => {
    const entry = await loadUndoableEntry(ctx, input.id);
    await assertNoLaterChange(ctx, entry);
    const changes = changesColumn.decode(entry.changesJson);
    const { entityId } = entry;
    await refuseUniqueViolation(async () => {
      if (entityId === null) {
        await revertTenantList(ctx, entry.operation, changes);
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
    recordRevert(
      ctx,
      { id: entry.id, entity: { kind: entry.entityKind, id: entry.entityId } },
      changes
    );
    return { id: entry.id };
  }
});
