import { newId, nowIso, type Db, type ReloadKind } from '@zamfono/shared';

import {
  beginAudit,
  readAudit,
  readPropagates,
  readReloadKinds
} from './audit.js';
import { notifyPropagation } from './propagationHooks.js';
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

export { maskContent, recordChange, setUndoable } from './audit.js';
export { onPropagate, propagate } from './propagationHooks.js';
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
// inside its `run` (Tasks 20-26).
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
  const audit = readAudit(ctx);
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
      changesJson: JSON.stringify(audit?.changes ?? []),
      undoable: audit?.undoable === false ? 0 : 1,
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
  beginAudit(ctx);
  const output = await op.run(ctx, input);
  if (!op.readOnly && op.audit !== false) {
    await writeAuditRow({ ctx, op, name, run, input, output });
  }
  return output;
}

type Committed = {
  output: unknown;
  kinds: ReloadKind[];
  propagates: boolean;
};

/**
 * Runs the operation and its audit write in one transaction. Should the transaction not commit,
 * the rollback hooks the operation registered (`onRollback`) run before the error reaches the
 * caller, since the rollback takes back only what the database holds.
 */
async function executeInTransaction(
  db: Db,
  execution: Omit<Execution, 'ctx'>
): Promise<Committed> {
  // Held outside the transaction, so its hooks can still be reached once the transaction failed.
  const scope: { ctx?: Context } = {};
  try {
    return await db.transaction().execute(async trx => {
      const ctx: Context = {
        actor: execution.run.actor,
        db: trx,
        now: nowIso(),
        channel: execution.run.channel,
        clientId: execution.run.clientId,
        clientName: execution.run.clientName,
        requestId: execution.run.requestId
      };
      scope.ctx = ctx;
      const output = await executeOperation({ ...execution, ctx });
      return {
        output,
        kinds: readReloadKinds(ctx),
        propagates: readPropagates(ctx)
      };
    });
  } catch (error) {
    if (scope.ctx) {
      await runRollbackHooks(scope.ctx, error);
    }
    throw error;
  }
}

/* eslint-disable @typescript-eslint/no-unused-vars -- `In` documents an operation's input type at the call site; only `name` selects the operation at runtime */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- `In` documents an operation's input type at the call site; only `name` selects the operation at runtime */
/**
 * Validates `input` against the named operation's schema (422), enforces its `minRole` (403)
 * and its confirmation gate (409), runs it in one transaction with its audit row, then, for a
 * non-`readOnly` operation that requested reload kinds via `propagate()`, notifies every
 * `onPropagate` hook with the deduplicated set once the transaction has committed (§10.3, §3.1).
 * The operation's own result is returned once the commit succeeds, whatever the hooks report.
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
  const { output, kinds, propagates } = await executeInTransaction(db, {
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
  if (!op.readOnly && propagates) {
    await notifyPropagation(name, kinds);
  }
  return output as Out;
}
/* eslint-enable @typescript-eslint/no-unused-vars */
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
