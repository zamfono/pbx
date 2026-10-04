import { HTTP_CONFLICT } from '@zamfono/shared';

import { absorbEffects, newEffects } from './effects.js';
import { registry, type ErasedOperation } from './registry.js';
import { OpError, type Context } from './types.js';

/** An operation an undo replays, its input parsed and its `prepare` run (`prepareReplay`). */
export type PreparedReplay = {
  name: string;
  op: ErasedOperation;
  input: unknown;
  prepared: unknown;
};

/**
 * Resolves the replay of `input` through the operation `name` (§5.8). An operation not
 * registered, or a recorded diff that does not form a valid input for it, is refused with a 409,
 * so the entry stays live and the caller learns why.
 */
function resolveReplay(
  name: string,
  input: unknown
): { op: ErasedOperation; input: unknown } {
  const op = registry.get(name);
  if (!op) {
    throw new OpError(
      HTTP_CONFLICT,
      `audit.undo: operation '${name}' is not registered`
    );
  }
  const parsed = op.input.safeParse(input);
  if (!parsed.success) {
    throw new OpError(
      HTTP_CONFLICT,
      `audit.undo: '${name}' cannot take this change back`,
      parsed.error.issues
    );
  }
  return { op, input: parsed.data };
}

/**
 * Resolves a replay and runs the operation's `prepare`, for the undo's own `prepare` before its
 * transaction opens: a `prepare` never runs inside a transaction (`Operation.prepare`). What it
 * leaves outside the database it takes back through `ctx`'s rollback hooks.
 */
export async function prepareReplay(
  ctx: Context,
  name: string,
  input: unknown
): Promise<PreparedReplay> {
  const replay = resolveReplay(name, input);
  const prepared = await replay.op.prepare?.(ctx, replay.input);
  return { name, ...replay, prepared };
}

/**
 * Runs a replay as part of the undo `ctx` runs (§5.8: "Field changes are reverted by writing the
 * `from` values back through the normal operations"), so it never asks confirmation (§10.3). It
 * writes no audit entry of its own, since the undo's entry records the revert; what it
 * propagates, runs after the commit or warns joins `ctx`'s.
 */
export async function runReplay(
  ctx: Context,
  { op, input, prepared }: PreparedReplay
): Promise<void> {
  const effects = newEffects();
  try {
    await op.run({ ...ctx, effects }, input, prepared);
  } finally {
    absorbEffects(ctx.effects, effects);
  }
}

/**
 * Writes `input` back through the operation `name` as part of the undo `ctx` runs (`runReplay`).
 * An operation with a `prepare` is replayed through `prepareReplay` instead, before the undo's
 * transaction opens.
 */
export async function replayOperation(
  ctx: Context,
  name: string,
  input: unknown
): Promise<void> {
  const replay = resolveReplay(name, input);
  if (replay.op.prepare) {
    throw new Error(
      `audit.undo: '${name}' prepares outside the transaction; replay it through prepareReplay`
    );
  }
  await runReplay(ctx, { name, ...replay, prepared: undefined });
}
