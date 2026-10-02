import pino from 'pino';

import type { Db, ReloadKind } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import { propagateConfig } from '../propagation.js';
import type { Context } from './types.js';

// §3.1: a failed config propagation is logged, besides the warning the write's result carries,
// since the write it follows has already committed.
const logger = pino({ name: 'ops.runner' });

/**
 * Accumulates the reload kinds `ctx`'s operation's write touched; once it commits, the runner
 * propagates the deduplicated set, in first-requested order (§3.1), possibly none, since a write
 * `core` routes on without Asterisk holding it still drops `core`'s config cache.
 */
export function propagate(ctx: Context, kinds: ReloadKind[]): void {
  ctx.effects.propagates = true;
  for (const kind of kinds) {
    ctx.effects.reloadKinds.add(kind);
  }
}

/**
 * Propagates operation `name`'s committed write (`propagateConfig`) and answers why it failed,
 * logged, or `null` once it succeeded. The transaction has committed by the time this runs, so
 * the result reports the stored write; a failure leaves the running Asterisk configuration behind
 * the database, which `api` owes until a propagation succeeds (§3.1 "Config propagation").
 */
export async function notifyPropagation(
  db: Db,
  name: string,
  kinds: ReloadKind[]
): Promise<string | null> {
  try {
    await propagateConfig(db, kinds);
    return null;
  } catch (error) {
    logger.error(
      { err: error, operation: name, kind: kinds },
      'config propagation failed; the write is committed'
    );
    return errorMessage(error);
  }
}
