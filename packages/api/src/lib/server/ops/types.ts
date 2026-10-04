/* eslint-disable max-classes-per-file -- OpError and its two fixed-shape subclasses form one error hierarchy */
import type { Transaction } from 'kysely';
import type { z } from 'zod';

import {
  HTTP_CONFLICT,
  type AuditChannel,
  type DB,
  type UserRole
} from '@zamfono/shared';

import type { Effects } from './effects.js';

/** The authenticated caller of an operation. */
export type Actor = { id: string; name: string; role: UserRole };

/** Built by the runner for every call; `run` holds only what differs between operations (§10.3). */
export type Context = {
  /** The running operation's name, e.g. `users.list`: what its list cursors carry (§10.3). */
  operation: string;
  actor: Actor;
  db: Transaction<DB>;
  now: string;
  channel: AuditChannel;
  clientId?: string;
  clientName?: string;
  requestId: string;
  /** What `run` accumulates for the runner: the audit diff, reload kinds, after-commit steps. */
  effects: Effects;
};

/**
 * §5.3 own scope, which the runner checks for a `user` caller before confirmation and before
 * `run`: `'any'` when the input names nothing of another user's (a tenant-wide read, the caller's
 * own ringing call, or a list `run` narrows to the caller's own), else whether what the input
 * names is the caller's own, refused with 403 when it is not. It may throw the 404 of what the
 * input names not existing.
 */
export type OwnScope<In> =
  'any' | ((ctx: Context, input: In) => boolean | Promise<boolean>);

/**
 * One operation module's export (§10.3). The REST route table, the MCP tool list and the
 * OpenAPI document are all generated from the registry these fill. An operation a `user` may
 * call declares its `scope`; above that role every caller acts on anything (§5.3).
 */
export type Operation<In, Out> = {
  name: string;
  description: string;
  input: z.ZodType<In>;
  readOnly?: boolean;
  confirm?: (input: In) => string;
  /** `false` opts a write out of the audit log: presence, read flags, live-call actions (§5.7). */
  audit?: false;
  /**
   * Marks an audited call that changes no state of its entity: a test send, a sent reset link, a
   * credential reveal, a manual backup run (§5.8 "pure actions", §5.7 "reveals a secret"). Such an
   * entry never counts as a later live change blocking an undo of the entity's earlier entries
   * (§5.8).
   */
  pureAction?: true;
  /**
   * Omitted on reads; on a write, the entity its audit_log row names, except for an undo, whose
   * row names the entity of the entry it reverts (`recordRevert`).
   */
  entity?: (input: In, out: Out) => { kind: string; id: string | null };
  run(ctx: Context, input: In): Promise<Out>;
} & (
  | { minRole: Exclude<UserRole, 'user'> }
  | { minRole: 'user'; scope: OwnScope<In> }
);

/** Identity function that lets an operation module's `In`/`Out` be inferred from its body. */
export function defineOperation<In, Out>(
  op: Operation<In, Out>
): Operation<In, Out> {
  return op;
}

/** Thrown by an operation's `run`, or by the runner itself, to answer with an RFC 9457 problem. */
export class OpError extends Error {
  constructor(
    // eslint-disable-next-line no-magic-numbers -- the RFC 9457 status codes an operation may answer with
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503,
    public title: string,
    public detail?: unknown
  ) {
    super(title);
    this.name = 'OpError';
  }
}

/** Raised by the runner when a `confirm`-guarded operation is called without confirmation (§10.3). */
export class ConfirmationRequired extends OpError {
  constructor(public question: string) {
    super(HTTP_CONFLICT, 'confirmation required', {
      confirmationRequired: true,
      question
    });
    this.name = 'ConfirmationRequired';
  }
}

/** Raised when a write is refused because other rows still reference or would collide with it. */
export class Conflict extends OpError {
  constructor(
    title: string,
    public references: { kind: string; id: string; label: string }[]
  ) {
    super(HTTP_CONFLICT, title, { references });
    this.name = 'Conflict';
  }
}

/* eslint-enable max-classes-per-file */
