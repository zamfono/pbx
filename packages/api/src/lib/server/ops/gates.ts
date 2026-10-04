import {
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  type UserRole
} from '@zamfono/shared';

import { registry, type ErasedOperation } from './registry.js';
import {
  ConfirmationRequired,
  OpError,
  type Actor,
  type Context
} from './types.js';

/** Owner outranks admin outranks user (§5.3); a lower number is more privileged. */
const ROLE_RANK: Record<UserRole, number> = { owner: 0, admin: 1, user: 2 };

export function findOperation(name: string): ErasedOperation {
  const op = registry.get(name);
  if (!op) {
    throw new OpError(HTTP_NOT_FOUND, `unknown operation '${name}'`);
  }
  return op;
}

export function parseInput(op: ErasedOperation, input: unknown): unknown {
  const parsed = op.input.safeParse(input);
  if (!parsed.success) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'validation failed',
      parsed.error.issues
    );
  }
  return parsed.data;
}

export function checkRole(op: ErasedOperation, actor: Actor): void {
  if (ROLE_RANK[actor.role] > ROLE_RANK[op.minRole]) {
    throw new OpError(HTTP_FORBIDDEN, 'forbidden');
  }
}

/** Throws 403 unless what the input names is a `user` caller's own (`Operation.scope`, §5.3); an
 *  `admin` or `owner` acts on anything. */
export async function checkScope(
  op: ErasedOperation,
  ctx: Context,
  input: unknown
): Promise<void> {
  if (
    ctx.actor.role !== 'user' ||
    op.minRole !== 'user' ||
    op.scope === 'any'
  ) {
    return;
  }
  if (!(await op.scope(ctx, input))) {
    throw new OpError(HTTP_FORBIDDEN, `${op.name}: not your own`);
  }
}

/** The `scope` of an operation addressing a user by `id`: the caller's own id alone. */
export function ownUserId(ctx: Context, input: { id: string }): boolean {
  return input.id === ctx.actor.id;
}

/** The `scope` of an operation acting for `userId`, the caller themselves when left out. */
export function ownActingUser(
  ctx: Context,
  input: { userId?: string }
): boolean {
  return input.userId === undefined || input.userId === ctx.actor.id;
}

/** MCP elicitation, the REST `confirm: true` body field and the UI dialog share this gate (§10.3); undo and jobs never ask. */
export async function checkConfirmation(
  op: ErasedOperation,
  ctx: Context,
  confirmed: boolean | undefined,
  input: unknown
): Promise<void> {
  const alwaysConfirmed = ctx.channel === 'undo' || ctx.channel === 'job';
  if (op.confirm && !alwaysConfirmed && confirmed !== true) {
    throw new ConfirmationRequired(await op.confirm(ctx, input));
  }
}
