import type { Db, ReloadKind } from '@zamfono/shared';

/** One field-level change, as stored in `audit_log.changes_json` (§5.7). */
export type ChangeEntry = { field: string; from: unknown; to: unknown };

/**
 * A step that runs once the operation's write has committed, outside its transaction, which has
 * ended: an effect that must not happen for a write that rolls back, such as a user's setup mail
 * (`afterCommit`), or one that also depends on Asterisk already holding the write, such as
 * Ringotel registering a device's new SIP credentials (§10.4, `afterPropagation`). It answers
 * `null`, or a warning for the operation's result: the write stands whatever the step reports, so
 * it cannot fail the call.
 */
export type AfterCommitHook = (db: Db) => Promise<string | null>;

/** A registered step, and whether it waits for Asterisk to hold the write (§3.1). */
export type AfterCommitStep = {
  hook: AfterCommitHook;
  waitsForAsterisk: boolean;
};

/** Undoes an effect outside the database, given the error that rolled the transaction back. */
export type RollbackHook = (cause: unknown) => Promise<void>;

/**
 * What one operation call accumulates while it runs, for the runner to act on once `run`
 * returns: the audit entry's diff and undoability (§5.7, §5.8), the reload kinds it requested
 * via `propagate()` (§3.1), what runs after the commit or should the transaction not commit,
 * and the warnings its result carries.
 */
export type Effects = {
  changes: ChangeEntry[];
  undoable: boolean;
  contentMasked: boolean;
  reloadKinds: Set<ReloadKind>;
  propagates: boolean;
  after: AfterCommitStep[];
  rollback: RollbackHook[];
  warnings: string[];
};

/** A fresh record for one call: no change yet, undoable, nothing to propagate or run. */
export function newEffects(): Effects {
  return {
    changes: [],
    undoable: true,
    contentMasked: false,
    reloadKinds: new Set(),
    propagates: false,
    after: [],
    rollback: [],
    warnings: []
  };
}
