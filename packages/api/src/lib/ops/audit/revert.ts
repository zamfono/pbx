import { revertHoursSet } from '../hours/revert.js';
import { revertMailTemplate } from '../mailTemplates/revert.js';
import { revertParkingSet } from '../parking/revert.js';
import { pushRoster } from '../roster.js';
import { revertSettingsUpdate } from '../settings/revert.js';
import { OpError, type Context } from '../types.js';
import {
  revertBlfKeys,
  revertDevices,
  revertExtension,
  revertSoftDelete
} from './_cascadeRevert.js';
import { LIST_REVERTS, type EntryRevert } from './_listReverts.js';
import { replayOperation } from './_replay.js';
import type { ChangeEntry } from './_shared.js';
import { restoreProvisionedDevices } from './restoreProvisioning.js';

const STATUS_CONFLICT = 409;

/**
 * `<entityKind>.update`, the operation a plain field change replays through (§5.8, §10.3
 * "Callers"). A kind absent here has no `update` a single recorded field can address — `parking`
 * and `mailTemplate` are set as a whole, `outboundRoute` and a trunk's order are whole-list
 * replaces, each reverted through `WHOLE_ENTRY_REVERTS` or `revertTenantList` instead — and
 * `revertField` refuses it with a 409.
 */
const FIELD_UPDATE_OPERATIONS: Partial<Record<string, string>> = {
  user: 'users.update',
  device: 'devices.update',
  ringGroup: 'ringGroups.update',
  menu: 'menus.update',
  did: 'dids.update',
  trunk: 'trunks.update',
  webhook: 'webhooks.update',
  contact: 'contacts.update',
  audio: 'audio.update',
  didBlock: 'didBlocks.update',
  userGroup: 'userGroups.update',
  oooRule: 'ooo.update',
  backupTarget: 'backups.targets.update',
  settings: 'settings.update'
};

/**
 * Entity kinds addressed by an `update` that takes no `id`, because the kind is a singleton
 * (§11.4 `settings`): the replayed input carries the recorded field alone.
 */
const SINGLETON_UPDATE_KINDS = new Set(['settings']);

/**
 * Operations whose recorded fields are parts of one whole replace and go back together, through
 * the operation that wrote them, rather than field by field (§5.8).
 */
const WHOLE_ENTRY_REVERTS: Partial<Record<string, EntryRevert>> = {
  'hours.set': revertHoursSet,
  'parking.set': revertParkingSet,
  'mailTemplates.put': revertMailTemplate,
  'mailTemplates.delete': revertMailTemplate,
  'settings.update': revertSettingsUpdate,
  ...LIST_REVERTS
};

/**
 * `<entityKind>.delete`, the operation a creation entry's undo reverts through (§5.8): a
 * creation's diff records every field's `from` as `null`, which no `update` operation accepts
 * back (e.g. a `null` extension), so undoing one deletes the row its `create` inserted instead of
 * replaying the diff field by field. Keyed like `ENTITY_TABLES`, minus kinds with no per-id
 * `create`/`delete` pair of their own (`openingHours` is set, never created, through `hours.set`).
 */
const CREATION_DELETE_OPERATIONS: Partial<Record<string, string>> = {
  user: 'users.delete',
  device: 'devices.delete',
  ringGroup: 'ringGroups.delete',
  menu: 'menus.delete',
  did: 'dids.delete',
  didBlock: 'didBlocks.delete',
  trunk: 'trunks.delete',
  webhook: 'webhooks.delete',
  contact: 'contacts.delete',
  audio: 'audio.delete',
  userGroup: 'userGroups.delete',
  oooRule: 'ooo.delete',
  backupTarget: 'backups.targets.delete',
  blockedNumber: 'blockedNumbers.delete'
};

/**
 * Reverts a creation entry by deleting the row its `create` inserted, through the entity's own
 * `delete` operation, so the usual cascades (devices, extension, tokens, §5.9) apply the same way
 * a normal delete would (§5.8).
 */
export async function revertCreation(
  ctx: Context,
  entityKind: string,
  entityId: string
): Promise<void> {
  const opName = CREATION_DELETE_OPERATIONS[entityKind];
  if (!opName) {
    throw new OpError(
      STATUS_CONFLICT,
      `audit.undo: entity kind '${entityKind}' cannot be reverted`
    );
  }
  await replayOperation(ctx, opName, { id: entityId });
}

/**
 * Replays a plain field change through the entity's own `update` operation (§10.3, §5.8). The
 * recorded field is that operation's own input field, carrying its wire value, so a diff naming
 * something the operation does not take is refused with a 409 by `replayOperation`.
 */
async function revertField(
  ctx: Context,
  entityKind: string,
  entityId: string,
  field: string,
  value: unknown
): Promise<void> {
  const opName = FIELD_UPDATE_OPERATIONS[entityKind];
  if (!opName) {
    throw new OpError(
      STATUS_CONFLICT,
      `audit.undo: entity kind '${entityKind}' cannot be reverted`
    );
  }
  const input = SINGLETON_UPDATE_KINDS.has(entityKind)
    ? { [field]: value }
    : { id: entityId, [field]: value };
  await replayOperation(ctx, opName, input);
}

/**
 * Reverts one recorded field change, by the field-name conventions every delete cascade shares.
 * A creation entry (every recorded `from` is `null`) is not replayed field by field; `undo.ts`
 * routes it through `revertCreation` instead, before ever calling this function.
 */
async function revertChange(
  ctx: Context,
  entityKind: string,
  entityId: string,
  change: ChangeEntry
): Promise<void> {
  switch (change.field) {
    // §5.9: undo restores the devices; tokens stay revoked and the person signs in again.
    case 'tokensRevoked':
      return;
    case 'deletedAt':
      await revertSoftDelete(ctx, entityKind, entityId);
      return;
    case 'ext':
      await revertExtension(ctx, entityKind, entityId, change.from as string);
      return;
    case 'devices':
      await revertDevices(ctx, change.from as { id: string }[]);
      return;
    case 'droppedBlfKeys':
      await revertBlfKeys(
        ctx,
        change.from as { deviceId: string; ext: string; position: number }[]
      );
      return;
    default:
      await revertField(ctx, entityKind, entityId, change.field, change.from);
  }
}

/**
 * Reverts one recorded entry that is not a creation (§5.8): through the reverter its operation
 * brings, where the entry's fields are parts of one replace, and field by field otherwise.
 */
export async function revertEntry(
  ctx: Context,
  entry: { operation: string; entityKind: string; entityId: string },
  changes: ChangeEntry[]
): Promise<void> {
  const wholeEntry = WHOLE_ENTRY_REVERTS[entry.operation];
  if (wholeEntry) {
    await wholeEntry(ctx, entry.entityId, changes);
    return;
  }
  for (const change of changes) {
    // eslint-disable-next-line no-await-in-loop -- each field's revert depends on the state the previous one left in the shared transaction
    await revertChange(ctx, entry.entityKind, entry.entityId, change);
  }
  // Only once every field is back: a user's devices and extension are separate fields of the
  // deletion's diff (§5.9), and the provider pushes the restored devices with both (§10.4).
  if (changes.some(change => change.field === 'deletedAt')) {
    await restoreProvisionedDevices(ctx, entry.entityKind, entry.entityId);
  }
  // A re-inserted user or ring-group extension rejoins the roster (§10.4); an entry replayed
  // through its own operation pushes from there instead.
  if (changes.some(change => change.field === 'ext')) {
    await pushRoster(ctx);
  }
}
