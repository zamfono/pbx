import type { Effects, RollbackHook } from './effects.js';
import type { Context } from './types.js';

/**
 * Registers `hook` to run should `ctx`'s transaction not commit, whether `run`, the audit write
 * or the commit itself fails: for an effect outside the database that the rollback cannot take
 * back, such as an object a remote API created (§10.4 setup). Never runs after a commit.
 */
export function onRollback(
  ctx: Pick<Context, 'effects'>,
  hook: RollbackHook
): void {
  ctx.effects.rollback.push(hook);
}

/**
 * Runs a call's rollback hooks, latest first, the way the effects they undo were stacked. A hook
 * that fails too throws; its error, which should name what is left over, reaches the caller in
 * place of `cause`.
 */
export async function runRollbackHooks(
  effects: Effects,
  cause: unknown
): Promise<void> {
  for (const hook of effects.rollback.toReversed()) {
    // eslint-disable-next-line no-await-in-loop -- each undoes an effect stacked on the one the next undoes
    await hook(cause);
  }
}
