import {
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT
} from '@zamfono/shared';

import { registry, type ErasedOperation } from './registry.js';
import {
  ConfirmationRequired,
  OpError,
  type Actor,
  type Channel,
  type Role
} from './types.js';

/** Owner outranks admin outranks user (§5.3); a lower number is more privileged. */
const ROLE_RANK: Record<Role, number> = { owner: 0, admin: 1, user: 2 };

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

// Only `minRole` is enforced here. §5.3's own-scope rules (e.g. a `user` reading only their own
// voicemails) have no field on `Operation` to declare them and are each operation's own concern,
// inside its `run`.
export function checkRole(op: ErasedOperation, actor: Actor): void {
  if (ROLE_RANK[actor.role] > ROLE_RANK[op.minRole]) {
    throw new OpError(HTTP_FORBIDDEN, 'forbidden');
  }
}

/** MCP elicitation, the REST `confirm: true` body field and the UI dialog share this gate (§10.3); undo and jobs never ask. */
export function checkConfirmation(
  op: ErasedOperation,
  run: { channel: Channel; confirm?: boolean },
  input: unknown
): void {
  const alwaysConfirmed = run.channel === 'undo' || run.channel === 'job';
  if (op.confirm && !alwaysConfirmed && run.confirm !== true) {
    throw new ConfirmationRequired(op.confirm(input));
  }
}
