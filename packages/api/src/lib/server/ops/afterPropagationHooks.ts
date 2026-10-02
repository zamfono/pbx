import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import type { Context } from './types.js';

/**
 * A step that runs once the operation's write has committed, outside its transaction, which has
 * ended: an effect that must not happen for a write that rolls back, such as a user's setup mail
 * (`afterCommit`), or one that also depends on Asterisk already holding the write, such as
 * Ringotel registering a device's new SIP credentials (§10.4, `afterPropagation`). It answers
 * `null`, or a warning for the operation's result: the write stands whatever the step reports, so
 * it cannot fail the call.
 */
export type AfterPropagationHook = (db: Db) => Promise<string | null>;

/** A registered step, and whether it waits for Asterisk to hold the write (§3.1). */
export type AfterPropagationStep = {
  hook: AfterPropagationHook;
  waitsForAsterisk: boolean;
};

const steps = new WeakMap<Context, AfterPropagationStep[]>();

// ponytail: in memory, so an `api` restart drops what waits; the writes and their warnings stand.
// The steps that wait for a propagation `api` still owes (§3.1), oldest first.
const waiting: AfterPropagationHook[] = [];

const log = pino({ name: 'ops.runner' });

function register(ctx: Context, step: AfterPropagationStep): void {
  const list = steps.get(ctx) ?? [];
  list.push(step);
  steps.set(ctx, list);
}

/**
 * Registers `hook` to run once `ctx`'s operation has committed and its configuration reached
 * Asterisk (§3.1 "Config propagation"); while that propagation is owed, it waits for it.
 */
export function afterPropagation(
  ctx: Context,
  hook: AfterPropagationHook
): void {
  register(ctx, { hook, waitsForAsterisk: true });
}

/** Registers `hook` to run once `ctx`'s operation has committed, whatever its propagation did. */
export function afterCommit(ctx: Context, hook: AfterPropagationHook): void {
  register(ctx, { hook, waitsForAsterisk: false });
}

/** Notes `warning`, found while `ctx`'s operation writes, for its result: it joins the hooks'
 * warnings, since the write it warns about stands. */
export function noteWarning(ctx: Context, warning: string): void {
  afterCommit(ctx, () => Promise.resolve(warning));
}

/** Takes `ctx`'s steps for the runner, in registration order, and forgets them. */
export function takeAfterPropagationHooks(
  ctx: Context
): AfterPropagationStep[] {
  const list = steps.get(ctx) ?? [];
  steps.delete(ctx);
  return list;
}

/**
 * Runs `list` one after the other and returns their warnings. A hook that throws is a warning
 * too, carrying its message, since the operation it follows has already committed.
 */
async function runInOrder(
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
 * Runs `list`, `ctx`'s steps, once its write committed and returns their warnings.
 * `propagationFailure`, the reason its propagation failed, or `null`, is the first warning; while
 * a propagation is owed, by this write or one before it, the steps that wait for Asterisk join
 * the waiting ones, ahead of anything that awaits, so the next successful propagation finds them.
 */
export async function runAfterPropagationHooks(
  db: Db,
  list: AfterPropagationStep[],
  propagationFailure: string | null
): Promise<string[]> {
  const owed = propagationFailure !== null || waiting.length > 0;
  const now: AfterPropagationHook[] = [];
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
  return [...warnings, ...(await runInOrder(db, now))];
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
