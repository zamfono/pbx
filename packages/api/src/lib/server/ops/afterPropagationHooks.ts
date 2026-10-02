import type { Db } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import type { Context } from './types.js';

/**
 * A step that must wait until the operation's write has committed and its configuration reached
 * Asterisk (§3.1 "Config propagation"): an effect elsewhere that depends on Asterisk already
 * holding the write, such as Ringotel registering a device's new SIP credentials (§10.4), or one
 * that must not happen for a write that rolls back, such as a user's setup mail. It gets
 * the database outside the transaction, which has ended, and answers `null`, or a warning for
 * the operation's result: the write stands whatever the step reports, so it cannot fail the call.
 */
export type AfterPropagationHook = (db: Db) => Promise<string | null>;

const hooks = new WeakMap<Context, AfterPropagationHook[]>();

/** Registers `hook` to run once `ctx`'s operation has committed and propagated (§3.1). */
export function afterPropagation(
  ctx: Context,
  hook: AfterPropagationHook
): void {
  const list = hooks.get(ctx) ?? [];
  list.push(hook);
  hooks.set(ctx, list);
}

/** Notes `warning`, found while `ctx`'s operation writes, for its result: it joins the hooks'
 * warnings, since the write it warns about stands. */
export function noteWarning(ctx: Context, warning: string): void {
  afterPropagation(ctx, () => Promise.resolve(warning));
}

/** Takes `ctx`'s hooks for the runner, in registration order, and forgets them. */
export function takeAfterPropagationHooks(
  ctx: Context
): AfterPropagationHook[] {
  const list = hooks.get(ctx) ?? [];
  hooks.delete(ctx);
  return list;
}

/**
 * Runs `list` one after the other and returns their warnings. A hook that throws is a warning
 * too, carrying its message, since the operation it follows has already committed.
 */
export async function runAfterPropagationHooks(
  db: Db,
  list: AfterPropagationHook[]
): Promise<string[]> {
  const warnings: string[] = [];
  for (const hook of list) {
    // eslint-disable-next-line no-await-in-loop -- each may depend on what the one before did
    const warning = await hook(db).catch((error: unknown) =>
      errorMessage(error)
    );
    if (warning !== null) {
      warnings.push(warning);
    }
  }
  return warnings;
}

/** `output` with `warnings` appended to any it already carries; a non-object passes unchanged. */
export function withWarnings(output: unknown, warnings: string[]): unknown {
  if (warnings.length === 0 || typeof output !== 'object' || output === null) {
    return output;
  }
  const current = (output as { warnings?: unknown }).warnings;
  return {
    ...output,
    warnings: [
      ...(Array.isArray(current) ? (current as unknown[]) : []),
      ...warnings
    ]
  };
}
