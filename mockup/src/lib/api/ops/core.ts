/**
 * The mock operations layer: one registry of operations with the API's gates (`ops/gates.ts`) —
 * minimum role, the own-scope predicate a `user` must pass, the owner-only condition, the
 * confirmation — plus audit entries and undo (§5.7, §5.8). Screens, Mucki and the simulator all
 * call operations through `call`, as the real UI, REST and MCP share one operations layer.
 *
 * A failing operation leaves the tenant untouched: `call` restores the snapshot it took before the
 * run, like the API's transaction rollback.
 */
import { nowDate as demoNowDate } from '#lib/clock.svelte.js';

import { ApiError, conflict, forbidden, type BlockingRef } from '../errors';
import { emit } from '../events.svelte';
import { newId } from '../ids';
import { snap, store, touch } from '../store.svelte';
import type {
  AuditChannel,
  AuditEntry,
  ChangeEntry,
  Db,
  Envelope,
  KeyTable,
  RevertStep,
  Role,
  RootTable,
  RowTable,
  ZEvent
} from '../types';

export type Actor = { id: string; name: string; role: Role };

/** The channels a mock call arrives on; `rest` is the API's, never the mockup's. */
export type Channel = Exclude<AuditChannel, 'rest'>;

/** What a confirmation dialog or Mucki's confirmation card states before a `confirm` operation. */
export type ConfirmInfo = {
  /** i18n key under `confirm.*`. */
  key: string;
  params?: Record<string, string | number>;
  /** Whether the API cannot undo the operation (§5.8): the dialog says so up front. */
  irreversible?: boolean;
  /** Whether the dialog should use the danger tone. */
  destructive?: boolean;
};

export class ConfirmationRequired extends ApiError {
  readonly info: ConfirmInfo;

  constructor(info: ConfirmInfo) {
    super(428, 'confirmationRequired', 'confirmation required');
    this.info = info;
  }
}

type AuditMeta = {
  entityKind: string;
  entityId: string | null;
  /** Field-level diff source: the row before and after. Omit both to give `changes` directly. */
  before?: unknown;
  after?: unknown;
  changes?: ChangeEntry[];
  /** Default: true. False for secrets, tokens, hard deletes and other irreversible writes. */
  undoable?: boolean;
  /** A pure action (re-registration, manual backup run): no prior state, never blocks an undo. */
  pure?: boolean;
  /** Overrides the operation name (e.g. `audit.undo`). */
  operation?: string;
};

export type Ctx = {
  db: Db;
  actor: Actor;
  channel: Channel;
  clientId: string | null;
  clientName: string | null;
  operation: string;
  now: string;
  /** Inserts a row; recorded for undo as a creation. */
  insert: <T extends { id: string }>(table: RowTable, row: T) => T;
  /** Replaces the row with the same id; recorded with its previous state. */
  put: <T extends { id: string }>(table: RowTable, row: T) => T;
  /** Sets `deletedAt` on a row (§5.9); recorded with its previous state. */
  softDelete: (table: RowTable, id: string) => void;
  /** Removes a row outright (hard delete); recorded, though such writes are usually not undoable. */
  remove: (table: RowTable, id: string) => void;
  setKey: (table: KeyTable, key: string, value: unknown) => void;
  setRoot: <K extends RootTable>(table: K, value: Db[K]) => void;
  /** Writes one audit entry covering the writes since the previous one. */
  audit: (meta: AuditMeta) => AuditEntry;
  emit: (event: ZEvent, audience?: string[]) => Envelope;
};

export type OpDef<I, O> = {
  name: string;
  minRole: Role;
  /** For a `user` caller: `'any'`, or whether what `input` names is the caller's own. */
  scope?: 'any' | ((ctx: Ctx, input: I) => boolean);
  /** Admins get 403 when this holds (`ownerOnly` in the API). */
  ownerOnly?: (ctx: Ctx, input: I) => boolean;
  /** A confirmation the call needs, or null when this input needs none. */
  confirm?: (ctx: Ctx, input: I) => ConfirmInfo | null;
  readOnly?: boolean;
  run: (ctx: Ctx, input: I) => O;
};

export type Op<I, O> = OpDef<I, O> & { readonly __io?: [I, O] };

const ROLE_RANK: Record<Role, number> = { owner: 0, admin: 1, user: 2 };

export const hasRole = (role: Role, min: Role): boolean =>
  ROLE_RANK[role] <= ROLE_RANK[min];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the registry holds every op's types
const registry = new Map<string, Op<any, any>>();

export function defineOp<I, O>(definition: OpDef<I, O>): Op<I, O> {
  if (registry.has(definition.name)) {
    throw new Error(`operation ${definition.name} defined twice`);
  }
  registry.set(definition.name, definition);
  return definition;
}

export function getOp(name: string): Op<unknown, unknown> | undefined {
  return registry.get(name);
}

export function operationNames(): string[] {
  return [...registry.keys()].sort();
}

/* ---------------- diffs ---------------- */

const SECRET_FIELD = /password|secret|token/iu;
const MASK = '•••';

function isSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The field-level diff of two row states; secret values are masked (§5.7). */
export function diff(before: unknown, after: unknown): ChangeEntry[] {
  const from = (before ?? {}) as Record<string, unknown>;
  const to = (after ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const changes: ChangeEntry[] = [];
  for (const field of keys) {
    if (field === 'id' || field === 'createdAt' || field === 'password') {
      continue;
    }
    if (!isSame(from[field], to[field])) {
      const secret = SECRET_FIELD.test(field) && !field.endsWith('Set');
      changes.push({
        field,
        from: secret ? MASK : (from[field] ?? null),
        to: secret ? MASK : (to[field] ?? null)
      });
    }
  }
  return changes;
}

/* ---------------- context ---------------- */

function findRow(
  db: Db,
  table: RowTable,
  id: string
): { id: string } | undefined {
  return (db[table] as { id: string }[]).find(row => row.id === id);
}

function createCtx(db: Db, operation: string, options: CallOptions): Ctx {
  let pending: RevertStep[] = [];
  const now = demoNowDate().toISOString();

  const ctx: Ctx = {
    db,
    actor: options.actor,
    channel: options.channel,
    clientId: options.clientId ?? null,
    clientName: options.clientName ?? null,
    operation,
    now,
    insert: (table, row) => {
      (db[table] as unknown[]).push(row);
      pending.push({ kind: 'row', table, id: row.id, before: null });
      return row;
    },
    put: (table, row) => {
      const rows = db[table] as { id: string }[];
      const index = rows.findIndex(existing => existing.id === row.id);
      if (index === -1) {
        throw new Error(`put: ${table} ${row.id} missing`);
      }
      pending.push({
        kind: 'row',
        table,
        id: row.id,
        before: snap(rows[index])
      });
      rows[index] = row;
      return row;
    },
    softDelete: (table, id) => {
      const row = findRow(db, table, id) as
        { deletedAt?: string | null } | undefined;
      if (row === undefined) {
        throw new Error(`softDelete: ${table} ${id} missing`);
      }
      pending.push({ kind: 'row', table, id, before: snap(row) });
      row.deletedAt = now;
    },
    remove: (table, id) => {
      const rows = db[table] as { id: string }[];
      const index = rows.findIndex(existing => existing.id === id);
      if (index !== -1) {
        pending.push({ kind: 'row', table, id, before: snap(rows[index]) });
        rows.splice(index, 1);
      }
    },
    setKey: (table, key, value) => {
      const record = db[table] as unknown as Record<string, unknown>;
      pending.push({ kind: 'key', table, key, before: snap(record[key]) });
      record[key] = value;
    },
    setRoot: (table, value) => {
      pending.push({ kind: 'root', table, before: snap(db[table]) });
      db[table] = value;
    },
    audit: meta => {
      const entry: AuditEntry = {
        id: newId(),
        actorUserId: ctx.actor.id,
        actorUserName: ctx.actor.name,
        channel: ctx.channel,
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        operation: meta.operation ?? operation,
        entityKind: meta.entityKind,
        entityId: meta.entityId,
        changes: meta.changes ?? diff(meta.before, meta.after),
        undoable: meta.pure === true ? false : (meta.undoable ?? true),
        revertsId: null,
        undoneAt: null,
        createdAt: now,
        revert: pending,
        ...(meta.pure === true ? { pure: true } : {})
      };
      pending = [];
      db.audit.unshift(entry);
      return entry;
    },
    emit: (event, audience) => emit(event, audience)
  };
  return ctx;
}

/* ---------------- call ---------------- */

export type CallOptions = {
  actor: Actor;
  channel: Channel;
  /** `confirm: true` of the API: the person confirmed in a dialog or Mucki's card. */
  confirmed?: boolean;
  clientId?: string;
  clientName?: string;
};

/** Runs operation `name` as the API would: gates first, then the operation, all or nothing. */
export function call<O = unknown>(
  name: string,
  input: unknown,
  options: CallOptions
): O {
  const op = registry.get(name);
  if (op === undefined) {
    throw new ApiError(404, 'unknownOperation', `unknown operation ${name}`, {
      params: { name }
    });
  }
  const db = store.db;
  const ctx = createCtx(db, name, options);

  if (!hasRole(ctx.actor.role, op.minRole)) {
    throw new ApiError(
      403,
      'forbiddenRole',
      `${name} needs role ${op.minRole}`,
      {
        params: { role: op.minRole }
      }
    );
  }
  if (
    ctx.actor.role === 'user' &&
    op.scope !== undefined &&
    op.scope !== 'any' &&
    !op.scope(ctx, input)
  ) {
    throw new ApiError(403, 'forbiddenNotOwn', `${name}: not your own`);
  }
  if (ctx.actor.role !== 'owner' && op.ownerOnly?.(ctx, input) === true) {
    throw new ApiError(403, 'forbiddenOwnerOnly', `${name}: owner only`);
  }
  const confirmation = op.confirm?.(ctx, input) ?? null;
  const alwaysConfirmed = ctx.channel === 'undo' || ctx.channel === 'job';
  if (confirmation !== null && !alwaysConfirmed && options.confirmed !== true) {
    throw new ConfirmationRequired(confirmation);
  }

  if (op.readOnly === true) {
    return op.run(ctx, input) as O;
  }
  const before = snap(db);
  try {
    const result = op.run(ctx, input) as O;
    touch();
    return result;
  } catch (error) {
    store.db = before;
    throw error;
  }
}

/** The confirmation an operation would ask for this input, without running it. */
export function confirmationFor(
  name: string,
  input: unknown,
  options: CallOptions
): ConfirmInfo | null {
  const op = registry.get(name);
  if (op?.confirm === undefined) {
    return null;
  }
  return op.confirm(createCtx(store.db, name, options), input);
}

/** Whether `actor` passes the role, scope and owner-only gates of `name` for `input` — for hiding
 * actions an operation would refuse. */
export function allowed(name: string, input: unknown, actor: Actor): boolean {
  const op = registry.get(name);
  if (op === undefined || !hasRole(actor.role, op.minRole)) {
    return false;
  }
  const ctx = createCtx(store.db, name, { actor, channel: 'ui' });
  try {
    if (
      actor.role === 'user' &&
      op.scope !== undefined &&
      op.scope !== 'any' &&
      !op.scope(ctx, input)
    ) {
      return false;
    }
    return !(actor.role !== 'owner' && op.ownerOnly?.(ctx, input) === true);
  } catch {
    return false;
  }
}

/* ---------------- undo (§5.8) ---------------- */

/** Uniqueness rules a revived or reverted row must still satisfy, per table. */
const UNIQUE_KEYS: Partial<Record<RowTable, string[]>> = {
  users: ['extension', 'email'],
  ringGroups: ['name', 'ext'],
  userGroups: ['name'],
  menus: ['name'],
  dids: ['number'],
  didBlocks: ['base'],
  trunks: ['name'],
  sipAllowlist: ['address']
};

const isLive = (row: unknown): boolean =>
  (row as { deletedAt?: string | null }).deletedAt == null;

function uniquenessConflicts(
  db: Db,
  step: Extract<RevertStep, { kind: 'row' }>
): BlockingRef[] {
  const restored = step.before as Record<string, unknown> | null;
  if (restored === null || !isLive(restored)) {
    return [];
  }
  const refs: BlockingRef[] = [];
  for (const key of UNIQUE_KEYS[step.table] ?? []) {
    const value = restored[key];
    if (value === null || value === undefined) {
      continue;
    }
    const clash = (db[step.table] as Record<string, unknown>[]).find(
      row =>
        row.id !== step.id &&
        isLive(row) &&
        String(row[key]).toLowerCase() === String(value).toLowerCase()
    );
    if (clash !== undefined) {
      refs.push({
        kind: step.table,
        id: String(clash.id),
        label: String(clash.name ?? clash.number ?? clash[key])
      });
    }
  }
  return refs;
}

function applyRevert(db: Db, step: RevertStep, now: string): void {
  if (step.kind === 'root') {
    (db as Record<string, unknown>)[step.table] = step.before;
    return;
  }
  if (step.kind === 'key') {
    const record = db[step.table] as unknown as Record<string, unknown>;
    if (step.before === undefined) {
      delete record[step.key];
    } else {
      record[step.key] = step.before;
    }
    return;
  }
  const rows = db[step.table] as Record<string, unknown>[];
  const index = rows.findIndex(row => row.id === step.id);
  if (step.before === null) {
    // Undoing a creation soft-deletes the row, as the API's revert does.
    if (index !== -1) {
      const row = rows[index] as Record<string, unknown>;
      if ('deletedAt' in row) {
        row.deletedAt = now;
      } else {
        rows.splice(index, 1);
      }
    }
    return;
  }
  if (index === -1) {
    rows.push(step.before as Record<string, unknown>);
  } else {
    rows[index] = step.before as Record<string, unknown>;
  }
}

/** Reverts audit entry `entryId` (§5.8); used by the `audit.undo` operation. */
export function undoEntry(ctx: Ctx, entryId: string): AuditEntry {
  const db = ctx.db;
  const entry = db.audit.find(candidate => candidate.id === entryId);
  if (entry === undefined) {
    throw new ApiError(404, 'notFound', `audit entry '${entryId}' not found`, {
      params: { what: 'audit', id: entryId }
    });
  }
  if (entry.undoneAt !== null) {
    throw conflict('undoAlreadyUndone', 'entry already undone');
  }
  if (!entry.undoable) {
    throw conflict('undoNotUndoable', 'entry cannot be undone');
  }
  const later = db.audit.filter(
    other =>
      other.createdAt > entry.createdAt &&
      other.id !== entry.id &&
      other.entityKind === entry.entityKind &&
      other.entityId === entry.entityId &&
      other.undoneAt === null &&
      other.operation !== 'audit.undo' &&
      other.pure !== true
  );
  if (later.length > 0) {
    throw conflict(
      'undoLaterChange',
      'a later live change to the same entity exists',
      later.map(other => ({
        kind: 'audit',
        id: other.id,
        label: `${other.operation} · ${other.actorUserName}`
      }))
    );
  }
  const steps = [...(entry.revert ?? [])].reverse();
  const clashes = steps.flatMap(step =>
    step.kind === 'row' ? uniquenessConflicts(db, step) : []
  );
  if (clashes.length > 0) {
    throw conflict(
      'undoUniqueness',
      'a newer row holds the same value',
      clashes
    );
  }
  for (const step of steps) {
    applyRevert(db, step, ctx.now);
  }
  entry.undoneAt = ctx.now;
  const undo: AuditEntry = {
    id: newId(),
    actorUserId: ctx.actor.id,
    actorUserName: ctx.actor.name,
    channel: 'undo',
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    operation: 'audit.undo',
    entityKind: entry.entityKind,
    entityId: entry.entityId,
    changes: entry.changes.map(change => ({
      field: change.field,
      from: change.to,
      to: change.from
    })),
    undoable: false,
    revertsId: entry.id,
    undoneAt: null,
    createdAt: ctx.now
  };
  db.audit.unshift(undo);
  return undo;
}

/** Throws 403 unless the caller is at least `role` — for field-level checks inside `run`. */
export function requireRole(ctx: Ctx, role: Role, what: string): void {
  if (!hasRole(ctx.actor.role, role)) {
    throw forbidden(`${what} needs role ${role}`);
  }
}
