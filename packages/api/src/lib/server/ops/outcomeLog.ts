import { nowIso, type Db } from '@zamfono/shared';

import { insertAuditRow, type AuditCaller } from './audit.js';
import type { ChangeEntry } from './effects.js';
import type { Context } from './types.js';

/**
 * The `audit_log` operations that record what an effect outside Zamfono answered, rather than a
 * change Zamfono made (§5.7): a device's Ringotel push that ran after its operation committed,
 * the tenant profile's push (§10.4 "Tenant profile push"), the roster's push (§10.4 "Colleague
 * presence"), the re-registration a restart
 * triggers (§10.4), each automatic update attempt (§6.3 "Updates") and the maintenance gate
 * giving up (§6.4 "Maintenance gate"). They are written outside any operation's transaction,
 * never undoable, and, like a pure action, never block an undo of the entity's earlier entries
 * (§5.8).
 */
const OUTCOME_OPERATION_NAMES = [
  'ringotel.push',
  'ringotel.profile',
  'ringotel.roster',
  'ringotel.rereg',
  'system.autoUpdate',
  'system.maintenanceGate'
] as const;

export const OUTCOME_OPERATIONS: ReadonlySet<string> = new Set(
  OUTCOME_OPERATION_NAMES
);

export type OutcomeOperation = (typeof OUTCOME_OPERATION_NAMES)[number];

/** A background job's own entries (channel `job`): no person's action caused them. */
export const JOB_CALLER: AuditCaller = {
  actor: { id: 'system', name: 'Zamfono' },
  channel: 'job'
};

/** `ctx`'s caller, captured for an outcome row written once `ctx`'s transaction has ended. */
export function callerOf(ctx: Context): AuditCaller {
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
    caller: AuditCaller;
    operation: OutcomeOperation;
    entity: { kind: string; id: string | null };
    changes: ChangeEntry[];
  }
): Promise<void> {
  await insertAuditRow(db, {
    ...entry,
    undoable: false,
    revertsId: null,
    createdAt: nowIso()
  });
}
