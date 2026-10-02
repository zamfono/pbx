import pino from 'pino';

import type { ReloadKind } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import { addReloadKinds } from './audit.js';
import type { Context } from './types.js';

// §3.1: a failed config propagation is logged, besides the warning the write's result carries,
// since the write it follows has already committed.
const logger = pino({ name: 'ops.runner' });

type PropagationHook = (change: {
  operation: string;
  kind: ReloadKind[];
}) => Promise<void>;

const propagationHooks: PropagationHook[] = [];

/**
 * Registers a hook the runner calls, once, after a successful commit of a non-`readOnly`
 * operation that called `propagate()` (§3.1), with the reload kinds it requested — possibly
 * none, since a write `core` routes on without Asterisk holding it still drops `core`'s config
 * cache; never after a throw, and never for an operation that did not call `propagate()`.
 */
export function onPropagate(hook: PropagationHook): void {
  propagationHooks.push(hook);
}

/**
 * Accumulates the reload kinds `ctx`'s operation's write touched, next to its audit diff state;
 * the runner passes the deduplicated set to every `onPropagate` hook once it commits (§3.1).
 */
export function propagate(ctx: Context, kinds: ReloadKind[]): void {
  addReloadKinds(ctx, kinds);
}

/**
 * Runs every hook, logs the ones that reject and returns their reasons, or `null` once every
 * hook succeeded. The operation's transaction has committed by the time this runs, so its result
 * reports the stored write; a hook's failure leaves the running Asterisk configuration behind the
 * database, which `api` owes until a propagation succeeds (§3.1 "Config propagation"). Each hook
 * runs independently of the others' outcome.
 */
export async function notifyPropagation(
  name: string,
  kinds: ReloadKind[]
): Promise<string | null> {
  const results = await Promise.allSettled(
    propagationHooks.map(hook => hook({ operation: name, kind: kinds }))
  );
  const reasons: string[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error(
        { err: result.reason, operation: name, kind: kinds },
        'config propagation failed; the write is committed'
      );
      reasons.push(errorMessage(result.reason));
    }
  }
  return reasons.length === 0 ? null : reasons.join('; ');
}
