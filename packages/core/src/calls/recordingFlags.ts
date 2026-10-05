/**
 * Whose participation is recorded (§10.2 "Recording semantics"): the OR-resolution of a user's
 * own `record_calls` and that of the ring group that routed the participation.
 */
import { userById, type Snapshot } from '../internal/snapshot.js';
import type { Leg } from './call.js';

/** Whether `userId`'s own `record_calls` flag is set. */
export function userRecords(snapshot: Snapshot, userId: string): boolean {
  return userById(snapshot, userId)?.recordCalls === 1;
}

/** The user whose participation `leg` is: its own user's, or that of the user whose
 * unconditional forward it dials (`Leg.standsInFor`); `null` for a leg with no user behind it,
 * such as an outbound call's trunk leg ("A recording captures one user's participation"). */
export function legParticipant(leg: Leg): string | null {
  return leg.userId ?? leg.standsInFor ?? null;
}

/** Whether `leg`'s participation is recorded: its participant's own flag, or the flag of the ring
 * group that placed it (`Leg.ringGroupId`). A leg outside a group is governed by the user flag
 * alone, and a leg with no participant is never recorded. */
export function legRecords(snapshot: Snapshot, leg: Leg): boolean {
  const userId = legParticipant(leg);
  if (userId === null) {
    return false;
  }
  const group =
    leg.ringGroupId === undefined
      ? undefined
      : snapshot.ringGroups.find(row => row.id === leg.ringGroupId);
  return userRecords(snapshot, userId) || group?.recordCalls === 1;
}
