import { isDeepStrictEqual } from 'node:util';

import {
  changesColumn,
  newId,
  type AuditChannel,
  type ChangeEntry,
  type Db
} from '@zamfono/shared';

import type { RevertedEntry } from './effects.js';
import type { Actor, Context } from './types.js';

/**
 * Fields whose value is a secret: masked in `changes_json` and never revertible, since there is
 * no `from` to restore (§5.4, §5.8).
 */
const SECRET_FIELDS = new Set([
  'password',
  'secret',
  'token',
  'sipPassword',
  'smtpPassword',
  'ssoClientSecret',
  'ringotelApiToken'
]);

const MASKED_VALUE = '***';

/**
 * Appends one field change to `ctx`'s audit entry. A secret field is masked and marks the whole
 * entry non-undoable (§5.4, §5.8); so is every field of a content-masked entry (`maskContent`).
 */
export function recordChange(ctx: Context, change: ChangeEntry): void {
  const state = ctx.effects;
  if (state.contentMasked || SECRET_FIELDS.has(change.field)) {
    state.changes.push({
      field: change.field,
      from: MASKED_VALUE,
      to: MASKED_VALUE
    });
    state.undoable = false;
    return;
  }
  state.changes.push(change);
}

/**
 * How one column appears in the audit diff where it differs from its row: the wire field it maps
 * to and how its stored value decodes to the wire value (§10.3 "Conventions": storage suffixes
 * never cross the boundary). A column absent here is its own wire field, with its stored value.
 */
export type WireColumns<Row> = {
  [Column in keyof Row]?: {
    field?: string;
    decode?: (stored: Row[Column]) => unknown;
  };
};

/** A 0/1 column (nullable or not) as its wire `boolean` (§11.1, §10.3). */
export const fromFlag = (stored: number | null): boolean | null =>
  stored === null ? null : Boolean(stored);

/**
 * Records one field change per column of `after` whose wire value differs from `before`'s, under
 * its wire field name and value (`wire`), so `audit.undo` replays the diff straight back through
 * the operation's own input (§5.8). Returns the changed columns.
 */
export function recordFieldChanges<Row extends object>(
  ctx: Context,
  before: Row,
  after: Partial<Row>,
  wire: WireColumns<Row> = {}
): Partial<Row> {
  const changed: Partial<Row> = {};
  for (const column of Object.keys(after) as (keyof Row & string)[]) {
    const value = after[column] as Row[typeof column];
    const { field = column, decode = (stored: unknown) => stored } =
      wire[column] ?? {};
    const from = decode(before[column]);
    const to = decode(value);
    if (isDeepStrictEqual(from, to)) {
      continue;
    }
    recordChange(ctx, { field, from, to });
    changed[column] = value;
  }
  return changed;
}

/**
 * Masks every value of `ctx`'s audit entry, those recorded so far and any recorded later, keeping
 * only the field names, and marks it non-undoable: the GDPR erase call's own entry is
 * "content-masked, `undoable=0`" (§5.10), since its diff would otherwise carry the very data it
 * erases.
 */
export function maskContent(ctx: Context): void {
  const state = ctx.effects;
  state.contentMasked = true;
  state.undoable = false;
  state.changes = state.changes.map(change => ({
    field: change.field,
    from: MASKED_VALUE,
    to: MASKED_VALUE
  }));
}

/** Overrides `ctx`'s audit entry's undoability, for operations `recordChange` cannot cover (§5.8). */
export function setUndoable(ctx: Context, undoable: boolean): void {
  ctx.effects.undoable = undoable;
}

/**
 * Makes `ctx`'s audit entry the undo of `reverted` (§5.8): it names `reverted`'s entity, records
 * the reverse of `changes`, its diff, points `reverts_id` at it and is never undoable itself.
 */
export function recordRevert(
  ctx: Context,
  reverted: RevertedEntry,
  changes: ChangeEntry[]
): void {
  ctx.effects.reverts = reverted;
  ctx.effects.undoable = false;
  for (const change of changes) {
    recordChange(ctx, {
      field: change.field,
      from: change.to,
      to: change.from
    });
  }
}

/** Who an `audit_log` entry is attributed to: the actor, the channel and, for a token, the client. */
export type AuditCaller = {
  actor: Pick<Actor, 'id' | 'name'>;
  channel: AuditChannel;
  clientId?: string;
  clientName?: string;
};

/** One `audit_log` entry as its writers fill it; the insert assigns its id (§5.7, §11.2). */
export type AuditRow = {
  caller: AuditCaller;
  operation: string;
  entity: { kind: string; id: string | null };
  changes: ChangeEntry[];
  undoable: boolean;
  revertsId: string | null;
  createdAt: string;
};

/** Appends `row` to `audit_log`, not yet undone. */
export async function insertAuditRow(db: Db, row: AuditRow): Promise<void> {
  await db
    .insertInto('auditLog')
    .values({
      id: newId(),
      actorUserId: row.caller.actor.id,
      actorUserName: row.caller.actor.name,
      channel: row.caller.channel,
      clientId: row.caller.clientId ?? null,
      clientName: row.caller.clientName ?? null,
      operation: row.operation,
      entityKind: row.entity.kind,
      entityId: row.entity.id,
      changesJson: changesColumn.encode(row.changes),
      undoable: row.undoable ? 1 : 0,
      revertsId: row.revertsId,
      undoneAt: null,
      createdAt: row.createdAt
    })
    .execute();
}
