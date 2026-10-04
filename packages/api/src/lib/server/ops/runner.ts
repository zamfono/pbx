import {
  HTTP_CONFLICT,
  nowIso,
  type AuditChannel,
  type Db
} from '@zamfono/shared';

import { notifyUsersChanged } from '#lib/server/eventSink.js';

import {
  runAfterCommit,
  runRestartPush,
  runWaitingHooks,
  withWarnings
} from './afterCommit.js';
import { insertAuditRow, type AuditCaller } from './audit.js';
import { absorbEffects, newEffects, type Effects } from './effects.js';
import {
  checkConfirmation,
  checkRole,
  checkScope,
  findOperation,
  parseInput
} from './gates.js';
import { notifyPropagation } from './propagate.js';
import { registry, type ErasedOperation } from './registry.js';
import { runRollbackHooks } from './rollbackHooks.js';
import { OpError, type Actor, type Context } from './types.js';

/** What the runner needs beyond the operation's own input to build a `Context` (§10.3). */
export type RunInput = {
  actor: Actor;
  channel: AuditChannel;
  clientId?: string;
  clientName?: string;
  requestId: string;
  confirm?: boolean;
};

type AuditWrite = {
  ctx: Context;
  op: ErasedOperation;
  name: string;
  run: RunInput;
  input: unknown;
  output: unknown;
};

/**
 * Writes the `audit_log` row for a completed write, in the same transaction as its body (§5.7).
 * An undo's own entry is channel `undo` with no OAuth client, whoever called it (§5.8, §11.2).
 */
async function writeAuditRow({
  ctx,
  op,
  name,
  run,
  input,
  output
}: AuditWrite): Promise<void> {
  const { changes, undoable, reverts } = ctx.effects;
  const entity = reverts?.entity ?? op.entity?.(input, output);
  if (!entity) {
    throw new Error(
      `operation '${name}': entity() is required to audit a write`
    );
  }
  const caller: AuditCaller =
    reverts === null ? run : { actor: run.actor, channel: 'undo' };
  await insertAuditRow(ctx.db, {
    caller,
    operation: name,
    entity,
    changes,
    undoable,
    revertsId: reverts?.id ?? null,
    createdAt: ctx.now
  });
}

function newContext(
  db: Db,
  name: string,
  run: RunInput,
  effects: Effects
): Context {
  return {
    operation: name,
    actor: run.actor,
    db,
    now: nowIso(),
    channel: run.channel,
    clientId: run.clientId,
    clientName: run.clientName,
    requestId: run.requestId,
    effects
  };
}

type Execution = {
  op: ErasedOperation;
  run: RunInput;
  name: string;
  input: unknown;
};

async function checkGates(
  { op, run, input }: Execution,
  ctx: Context
): Promise<void> {
  await checkScope(op, ctx, input);
  await checkConfirmation(op, ctx, run.confirm, input);
}

/**
 * Runs the operation, accumulating its `effects`: its own scope (403) and confirmation (409)
 * gates, its `prepare`, then `run` and the audit write in one transaction. A call that writes
 * nothing to the database (`readOnly`, `writesDatabase: false`) runs without one, so the database
 * serves other requests while it waits. The gates share the transaction with `run` unless a
 * `prepare` stands between them, which runs only once they pass. Should the call not commit, the
 * rollback hooks it registered (`onRollback`) run before the error reaches the caller, since the
 * rollback takes back only what the database holds.
 */
async function executeCall(
  db: Db,
  effects: Effects,
  execution: Execution
): Promise<unknown> {
  const { op, run, name, input } = execution;
  try {
    let prepared: unknown;
    if (op.prepare) {
      const outside = newContext(db, name, run, effects);
      await checkGates(execution, outside);
      prepared = await op.prepare(outside, input);
    }
    const execute = async (database: Db): Promise<unknown> => {
      const ctx = newContext(database, name, run, effects);
      if (!op.prepare) {
        await checkGates(execution, ctx);
      }
      const output = await op.run(ctx, input, prepared);
      if (!op.readOnly && op.audit !== false) {
        await writeAuditRow({ ctx, op, name, run, input, output });
      }
      return output;
    };
    if (op.readOnly || op.writesDatabase === false) {
      return await execute(db);
    }
    return await db.transaction().execute(execute);
  } catch (error) {
    await runRollbackHooks(effects, error);
    throw error;
  }
}

/**
 * The role (403) and own-scope (403) gates `runOperation` applies, for `input` already parsed,
 * without running the operation: what a link to run it later is checked against before it is
 * handed out (§10.5 "Uploads").
 */
export async function checkAccess(
  db: Db,
  name: string,
  input: unknown,
  run: RunInput
): Promise<void> {
  const op = findOperation(name);
  checkRole(op, run.actor);
  await checkScope(op, newContext(db, name, run, newEffects()), input);
}

/**
 * Validates `input` against the named operation's schema (422), enforces its `minRole` (403),
 * then its own scope (403) and its confirmation gate (409) before running it with its audit row
 * (`executeCall`); then, for a non-`readOnly` operation that called `propagate()`,
 * propagates the deduplicated reload kinds once the transaction has committed (§10.3, §3.1). The operation's own result is returned once
 * the commit succeeds, whatever follows it reports; a failed propagation is a warning of it.
 */
export async function runOperation(
  db: Db,
  name: string,
  input: unknown,
  run: RunInput
): Promise<unknown> {
  const op = findOperation(name);
  const parsedInput = parseInput(op, input);
  checkRole(op, run.actor);
  const effects = newEffects();
  const output = await executeCall(db, effects, {
    op,
    run,
    name,
    input: parsedInput
  });
  // §10.6: any committed write may have changed a user's role, deletion or memberships, so the
  // open `/events` sockets are checked again against their users.
  if (!op.readOnly) {
    notifyUsersChanged();
  }
  // §3.1 "Config propagation": an operation that wrote configuration `core` reads tells it so,
  // which drops its config cache; the PJSIP regeneration and the Asterisk reload follow only
  // where the accumulated kinds ask for them. An operation that names no kind still propagates
  // when it called `propagate`, since a DID, a menu, an outbound route or an out-of-office rule
  // changes what `core` routes on without changing anything Asterisk holds.
  // A failed propagation is the result's first warning, and `api` owes it until one succeeds;
  // a successful one first runs what waited for an owed one, and last the push owed since `api`
  // started, which sends what those steps and this write's own send again.
  let propagationFailure: string | null = null;
  const propagated = !op.readOnly && effects.propagates;
  if (propagated) {
    propagationFailure = await notifyPropagation(db, name, [
      ...effects.reloadKinds
    ]);
    if (propagationFailure === null) {
      await runWaitingHooks(db);
    }
  }
  // What had to wait for the commit or for Asterisk to hold the write, such as Ringotel
  // registering a new device; its problems are the result's warnings, since the write stands.
  const warnings = await runAfterCommit(db, effects, propagationFailure);
  if (propagated && propagationFailure === null) {
    await runRestartPush(db);
  }
  return withWarnings(output, warnings);
}

/**
 * Writes `input` back through the operation `name` as part of the undo `ctx` runs (§5.8: "Field
 * changes are reverted by writing the `from` values back through the normal operations"), so it
 * never asks confirmation (§10.3). It writes no audit entry of its own, since the undo's entry
 * records the revert; what it propagates, runs after the commit or warns joins `ctx`'s. An operation not registered, or a recorded diff that does not form a valid input for
 * it, is refused with a 409, so the entry stays live and the caller learns why.
 */
export async function replayOperation(
  ctx: Context,
  name: string,
  input: unknown
): Promise<void> {
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
  const effects = newEffects();
  try {
    const prepared = await op.prepare?.({ ...ctx, effects }, parsed.data);
    await op.run({ ...ctx, effects }, parsed.data, prepared);
  } finally {
    absorbEffects(ctx.effects, effects);
  }
}
