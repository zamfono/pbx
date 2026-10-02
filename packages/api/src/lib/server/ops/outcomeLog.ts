import { newId, nowIso, type Db } from '@zamfono/shared';

import type { ChangeEntry } from './effects.js';
import type { Actor, Channel, Context } from './types.js';

/**
 * The `audit_log` operations that record what an effect outside Zamfono answered, rather than a
 * change Zamfono made (§5.7): a device's Ringotel push that ran after its operation committed,
 * the tenant profile's push (§10.4 "Tenant profile push"), the re-registration a restart
 * triggers (§10.4), each automatic update attempt (§6.3 "Updates") and the maintenance gate giving
 * up (§6.4 "Maintenance gate"). They are written outside
 * any operation's transaction, never undoable, and, like a pure action, never block an undo of
 * the entity's earlier entries (§5.8).
 */
export const OUTCOME_OPERATIONS: ReadonlySet<string> = new Set([
  'ringotel.push',
  'ringotel.profile',
  'ringotel.rereg',
  'system.autoUpdate',
  'system.maintenanceGate'
]);

export type OutcomeOperation =
  | 'ringotel.push'
  | 'ringotel.profile'
  | 'ringotel.rereg'
  | 'system.autoUpdate'
  | 'system.maintenanceGate';

/** Who an outcome row is attributed to: the caller of the operation it follows, or a job. */
export type OutcomeCaller = {
  actor: Pick<Actor, 'id' | 'name'>;
  channel: Channel;
  clientId?: string;
  clientName?: string;
};

/** A background job's own entries (channel `job`): no person's action caused them. */
export const JOB_CALLER: OutcomeCaller = {
  actor: { id: 'system', name: 'Zamfono' },
  channel: 'job'
};

/** `ctx`'s caller, captured for an outcome row written once `ctx`'s transaction has ended. */
export function callerOf(ctx: Context): OutcomeCaller {
  return {
    actor: { id: ctx.actor.id, name: ctx.actor.name },
    channel: ctx.channel,
    clientId: ctx.clientId,
    clientName: ctx.clientName
  };
}

/** Each `[field, value]` as a `{field, from: null, to: value}` entry, the `changes_json` shape. */
export function outcomeChanges(fields: Record<string, unknown>): ChangeEntry[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => ({ field, from: null, to: value }));
}

/** Appends one outcome row to `audit_log` (§5.7), outside any operation's transaction. */
export async function recordOutcome(
  db: Db,
  entry: {
    caller: OutcomeCaller;
    operation: OutcomeOperation;
    entity: { kind: string; id: string | null };
    changes: ChangeEntry[];
  }
): Promise<void> {
  await db
    .insertInto('auditLog')
    .values({
      id: newId(),
      actorUserId: entry.caller.actor.id,
      actorUserName: entry.caller.actor.name,
      channel: entry.caller.channel,
      clientId: entry.caller.clientId ?? null,
      clientName: entry.caller.clientName ?? null,
      operation: entry.operation,
      entityKind: entry.entity.kind,
      entityId: entry.entity.id,
      changesJson: JSON.stringify(entry.changes),
      undoable: 0,
      revertsId: null,
      undoneAt: null,
      createdAt: nowIso()
    })
    .execute();
}
