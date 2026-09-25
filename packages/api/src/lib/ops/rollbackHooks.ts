import type { Context } from './types.js';

/** Undoes an effect outside the database, given the error that rolled the transaction back. */
type RollbackHook = (cause: unknown) => Promise<void>;

// Keyed by the Context object, which the runner creates fresh per call, like the audit state.
const rollbackHooks = new WeakMap<Context, RollbackHook[]>();

/**
 * Registers `hook` to run should `ctx`'s transaction not commit, whether `run`, the audit write
 * or the commit itself fails: for an effect outside the database that the rollback cannot take
 * back, such as an object a remote API created (§10.4 setup). Never runs after a commit.
 */
export function onRollback(ctx: Context, hook: RollbackHook): void {
  const hooks = rollbackHooks.get(ctx) ?? [];
  hooks.push(hook);
  rollbackHooks.set(ctx, hooks);
}

/**
 * Runs `ctx`'s rollback hooks, latest first, the way the effects they undo were stacked. A hook
 * that fails too throws; its error, which should name what is left over, reaches the caller in
 * place of `cause`.
 */
export async function runRollbackHooks(
  ctx: Context,
  cause: unknown
): Promise<void> {
  const hooks = rollbackHooks.get(ctx) ?? [];
  rollbackHooks.delete(ctx);
  for (const hook of hooks.reverse()) {
    // eslint-disable-next-line no-await-in-loop -- each undoes an effect stacked on the one the next undoes
    await hook(cause);
  }
}
