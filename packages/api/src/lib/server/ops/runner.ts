import { newId, nowIso, type Db } from '@zamfono/shared';

import {
  runAfterCommit,
  runWaitingHooks,
  withWarnings
} from './afterCommit.js';
import { newEffects, type Effects } from './effects.js';
import { notifyPropagation } from './propagate.js';
import { registry, type ErasedOperation } from './registry.js';
import { runRollbackHooks } from './rollbackHooks.js';
import {
  ConfirmationRequired,
  OpError,
  type Actor,
  type Channel,
  type Context,
  type Role
} from './types.js';

export {
  maskContent,
  recordChange,
  recordFieldChanges,
  setUndoable
} from './audit.js';
export { propagate } from './propagate.js';
export { afterCommit, afterPropagation } from './afterCommit.js';
export { onRollback } from './rollbackHooks.js';

/** What the runner needs beyond the operation's own input to build a `Context` (§10.3). */
export type RunInput = {
  actor: Actor;
  channel: Channel;
  clientId?: string;
  clientName?: string;
  requestId: string;
  confirm?: boolean;
};

const STATUS_NOT_FOUND = 404;
const STATUS_FORBIDDEN = 403;
const STATUS_UNPROCESSABLE_ENTITY = 422;

/** Owner outranks admin outranks user (§5.3); a lower number is more privileged. */
const ROLE_RANK: Record<Role, number> = { owner: 0, admin: 1, user: 2 };

function findOperation(name: string): ErasedOperation {
  const op = registry.get(name);
  if (!op) {
    throw new OpError(STATUS_NOT_FOUND, `unknown operation '${name}'`);
  }
  return op;
}

function parseInput(op: ErasedOperation, input: unknown): unknown {
  const parsed = op.input.safeParse(input);
  if (!parsed.success) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      'validation failed',
      parsed.error.issues
    );
  }
  return parsed.data;
}

// Only `minRole` is enforced here. §5.3's own-scope rules (e.g. a `user` reading only their own
// voicemails) have no field on `Operation` to declare them and are each operation's own concern,
// inside its `run`.
function checkRole(op: ErasedOperation, actor: Actor): void {
  if (ROLE_RANK[actor.role] > ROLE_RANK[op.minRole]) {
    throw new OpError(STATUS_FORBIDDEN, 'forbidden');
  }
}

/** MCP elicitation, the REST `confirm: true` body field and the UI dialog share this gate (§10.3); undo and jobs never ask. */
function checkConfirmation(
  op: ErasedOperation,
  run: RunInput,
  input: unknown
): void {
  const alwaysConfirmed = run.channel === 'undo' || run.channel === 'job';
  if (op.confirm && !alwaysConfirmed && run.confirm !== true) {
    throw new ConfirmationRequired(op.confirm(input));
  }
}

type AuditWrite = {
  ctx: Context;
  op: ErasedOperation;
  name: string;
  run: RunInput;
  input: unknown;
  output: unknown;
};

/** Writes the `audit_log` row for a completed write, in the same transaction as its body (§5.7). */
async function writeAuditRow({
  ctx,
  op,
  name,
  run,
  input,
  output
}: AuditWrite): Promise<void> {
  // `register()` refuses an operation that needs an audit row but omits `entity()`, so this is
  // reached only for operations that supply one; the check narrows `entity` for TypeScript.
  const entity = op.entity?.(input, output);
  if (!entity) {
    throw new Error(
      `operation '${name}': entity() is required to audit a write`
    );
  }
  const { changes, undoable } = ctx.effects;
  await ctx.db
    .insertInto('auditLog')
    .values({
      id: newId(),
      actorUserId: run.actor.id,
      actorUserName: run.actor.name,
      channel: run.channel,
      clientId: run.clientId ?? null,
      clientName: run.clientName ?? null,
      operation: name,
      entityKind: entity.kind,
      entityId: entity.id,
      changesJson: JSON.stringify(changes),
      undoable: undoable ? 1 : 0,
      revertsId: null,
      undoneAt: null,
      createdAt: ctx.now
    })
    .execute();
}

type Execution = {
  op: ErasedOperation;
  ctx: Context;
  run: RunInput;
  name: string;
  input: unknown;
};

async function executeOperation({
  op,
  ctx,
  run,
  name,
  input
}: Execution): Promise<unknown> {
  const output = await op.run(ctx, input);
  if (!op.readOnly && op.audit !== false) {
    await writeAuditRow({ ctx, op, name, run, input, output });
  }
  return output;
}

/**
 * Runs the operation and its audit write in one transaction, accumulating its `effects`. Should
 * the transaction not commit, the rollback hooks the operation registered (`onRollback`) run
 * before the error reaches the caller, since the rollback takes back only what the database
 * holds.
 */
async function executeInTransaction(
  db: Db,
  effects: Effects,
  execution: Omit<Execution, 'ctx'>
): Promise<unknown> {
  try {
    return await db.transaction().execute(async trx =>
      executeOperation({
        ...execution,
        ctx: {
          actor: execution.run.actor,
          db: trx,
          now: nowIso(),
          channel: execution.run.channel,
          clientId: execution.run.clientId,
          clientName: execution.run.clientName,
          requestId: execution.run.requestId,
          effects
        }
      })
    );
  } catch (error) {
    await runRollbackHooks(effects, error);
    throw error;
  }
}

/* eslint-disable @typescript-eslint/no-unused-vars -- `In` documents an operation's input type at the call site; only `name` selects the operation at runtime */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- `In` documents an operation's input type at the call site; only `name` selects the operation at runtime */
/**
 * Validates `input` against the named operation's schema (422), enforces its `minRole` (403)
 * and its confirmation gate (409), runs it in one transaction with its audit row, then, for a
 * non-`readOnly` operation that called `propagate()`, propagates the deduplicated reload kinds
 * once the transaction has committed (§10.3, §3.1). The operation's own result is returned once
 * the commit succeeds, whatever follows it reports; a failed propagation is a warning of it.
 */
export async function runOperation<In, Out>(
  db: Db,
  name: string,
  input: unknown,
  run: RunInput
): Promise<Out> {
  const op = findOperation(name);
  const parsedInput = parseInput(op, input);
  checkRole(op, run.actor);
  checkConfirmation(op, run, parsedInput);
  const effects = newEffects();
  const output = await executeInTransaction(db, effects, {
    op,
    run,
    name,
    input: parsedInput
  });
  // §3.1 "Config propagation": an operation that wrote configuration `core` reads tells it so,
  // which drops its config cache; the PJSIP regeneration and the Asterisk reload follow only
  // where the accumulated kinds ask for them. An operation that names no kind still propagates
  // when it called `propagate`, since a DID, a menu, an outbound route or an out-of-office rule
  // changes what `core` routes on without changing anything Asterisk holds.
  // A failed propagation is the result's first warning, and `api` owes it until one succeeds;
  // a successful one first runs what waited for an owed one.
  let propagationFailure: string | null = null;
  if (!op.readOnly && effects.propagates) {
    propagationFailure = await notifyPropagation(db, name, [
      ...effects.reloadKinds
    ]);
    if (propagationFailure === null) {
      await runWaitingHooks(db);
    }
  }
  // What had to wait for the commit or for Asterisk to hold the write, such as Ringotel
  // registering a new device; its problems are the result's warnings, since the write stands.
  return withWarnings(
    output,
    await runAfterCommit(db, effects, propagationFailure)
  ) as Out;
}
/* eslint-enable @typescript-eslint/no-unused-vars */
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
