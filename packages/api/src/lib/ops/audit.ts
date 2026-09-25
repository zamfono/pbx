import type { ReloadKind } from '@zamfono/shared';

import type { Context } from './types.js';

/** One field-level change, as stored in `audit_log.changes_json` (§5.7). */
export type ChangeEntry = { field: string; from: unknown; to: unknown };

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

type AuditState = {
  changes: ChangeEntry[];
  undoable: boolean;
  contentMasked: boolean;
  reloadKinds: Set<ReloadKind>;
  propagates: boolean;
};

// Keyed by the Context object itself, which the runner creates fresh per call: this is the
// "ctx.db-adjacent helper" of §10.3, letting `run` call `recordChange(ctx, …)` without `Context`
// (a fixed, shared type) carrying an accumulator field of its own. The reload kinds an operation
// requests via `propagate()` accumulate here too, next to the audit diff state.
const auditStates = new WeakMap<Context, AuditState>();

/** Starts a fresh, undoable audit state for `ctx`; the runner calls this before `run`. */
export function beginAudit(ctx: Context): void {
  auditStates.set(ctx, {
    changes: [],
    undoable: true,
    contentMasked: false,
    reloadKinds: new Set(),
    propagates: false
  });
}

/** The audit state the runner started for `ctx`, if any. */
export function readAudit(ctx: Context): AuditState | undefined {
  return auditStates.get(ctx);
}

function requireAuditState(ctx: Context, caller: string): AuditState {
  const state = auditStates.get(ctx);
  if (!state) {
    throw new Error(`${caller}: no audit state for this context`);
  }
  return state;
}

/**
 * Appends one field change to `ctx`'s audit entry. A secret field is masked and marks the whole
 * entry non-undoable (§5.4, §5.8); so is every field of a content-masked entry (`maskContent`).
 */
export function recordChange(ctx: Context, change: ChangeEntry): void {
  const state = requireAuditState(ctx, 'recordChange');
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
 * Masks every value of `ctx`'s audit entry, those recorded so far and any recorded later, keeping
 * only the field names, and marks it non-undoable: the GDPR erase call's own entry is
 * "content-masked, `undoable=0`" (§5.10), since its diff would otherwise carry the very data it
 * erases.
 */
export function maskContent(ctx: Context): void {
  const state = requireAuditState(ctx, 'maskContent');
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
  requireAuditState(ctx, 'setUndoable').undoable = undoable;
}

/** Accumulates the reload kinds `ctx`'s operation requests via `propagate()` (§3.1). */
export function addReloadKinds(ctx: Context, kinds: ReloadKind[]): void {
  const state = requireAuditState(ctx, 'propagate');
  state.propagates = true;
  for (const kind of kinds) {
    state.reloadKinds.add(kind);
  }
}

/** The deduplicated reload kinds accumulated for `ctx`, in first-requested order. */
export function readReloadKinds(ctx: Context): ReloadKind[] {
  return [...(auditStates.get(ctx)?.reloadKinds ?? [])];
}

/** Whether `ctx`'s operation wrote configuration `core` reads, with or without a reload kind. */
export function readPropagates(ctx: Context): boolean {
  return auditStates.get(ctx)?.propagates === true;
}
