import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import type { AfterCommitHook, Effects } from './effects.js';
import type { Context } from './types.js';

// ponytail: in memory, so an `api` restart drops what waits; the writes and their warnings stand.
// The steps that wait for a propagation `api` still owes (§3.1), oldest first.
const waiting: AfterCommitHook[] = [];

const log = pino({ name: 'ops.runner' });

/**
 * Registers `hook` to run once `ctx`'s operation has committed and its configuration reached
 * Asterisk (§3.1 "Config propagation"); while that propagation is owed, it waits for it.
 */
export function afterPropagation(ctx: Context, hook: AfterCommitHook): void {
  ctx.effects.after.push({ hook, waitsForAsterisk: true });
}

/** Registers `hook` to run once `ctx`'s operation has committed, whatever its propagation did. */
export function afterCommit(ctx: Context, hook: AfterCommitHook): void {
  ctx.effects.after.push({ hook, waitsForAsterisk: false });
}

/** Notes `warning`, found while `ctx`'s operation writes, for its result: it joins the hooks'
 * warnings, since the write it warns about stands. */
export function noteWarning(ctx: Context, warning: string): void {
  ctx.effects.warnings.push(warning);
}

/**
 * Runs `list` one after the other and returns their warnings. A hook that throws is a warning
 * too, carrying its message, since the operation it follows has already committed.
 */
async function runInOrder(db: Db, list: AfterCommitHook[]): Promise<string[]> {
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

/**
 * Runs the steps that waited for an owed propagation, once one succeeded (§3.1). Their
 * operations have answered already, so their warnings go to the log.
 */
export async function runWaitingHooks(db: Db): Promise<void> {
  const warnings = await runInOrder(db, waiting.splice(0));
  for (const warning of warnings) {
    log.warn({ warning }, 'a step that waited for config propagation warns');
  }
}

/**
 * Runs the steps of a call's `effects` once its write committed and returns the result's
 * warnings. `propagationFailure`, the reason its propagation failed, or `null`, is the first
 * warning, followed by those noted while it wrote; while a propagation is owed, by this write or
 * one before it, the steps that wait for Asterisk join the waiting ones, ahead of anything that
 * awaits, so the next successful propagation finds them.
 */
export async function runAfterCommit(
  db: Db,
  effects: Effects,
  propagationFailure: string | null
): Promise<string[]> {
  const list = effects.after;
  const owed = propagationFailure !== null || waiting.length > 0;
  const now: AfterCommitHook[] = [];
  for (const step of list) {
    if (owed && step.waitsForAsterisk) {
      waiting.push(step.hook);
    } else {
      now.push(step.hook);
    }
  }
  const warnings: string[] = [];
  if (propagationFailure !== null) {
    warnings.push(
      `the change is stored but has not reached Asterisk (${propagationFailure}); api retries it until it does`
    );
  }
  if (now.length < list.length) {
    warnings.push(
      'what waits for Asterisk to hold the change, such as a Ringotel push, runs once it does'
    );
  }
  return [...warnings, ...effects.warnings, ...(await runInOrder(db, now))];
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
