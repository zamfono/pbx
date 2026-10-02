import type { ChangeEntry } from './effects.js';
import type { Context } from './types.js';

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

/** Records one field change per field of `after` whose resolved value differs from `before`'s. */
export function recordFieldChanges<Fields extends object>(
  ctx: Context,
  before: Fields,
  after: Fields
): void {
  for (const field of Object.keys(after) as (keyof Fields & string)[]) {
    if (after[field] !== before[field]) {
      recordChange(ctx, { field, from: before[field], to: after[field] });
    }
  }
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
