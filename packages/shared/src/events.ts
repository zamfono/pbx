/**
 * The realtime event union delivered on the `/events` WebSocket and to webhooks (§10.6). Every
 * event also carries `id` (uuid v7) and `at` (ISO), added by the emitter, as `Envelope`.
 */

import type { PresenceStatus } from './columnValues.js';
import type { MwiMailbox, TrunkStatus } from './internalApi.js';

export type Scope =
  'tenant' | `user:${string}` | `ringGroup:${string}` | `menu:${string}`;

/** Every event `type`, the names a webhook's event-type filter may hold (§10.6). */
export const EVENT_TYPES = [
  'presence',
  'call.state',
  'voicemail.new',
  'ooo',
  'hours',
  'trunk.status',
  'history.appended',
  'backup.started',
  'backup.finished',
  'backup.failed'
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Each event type's fields besides `type`. */
type EventFields = {
  presence: {
    userId: string;
    status: PresenceStatus;
    peer: string | null;
    ringGroupId: string | null;
  };
  'call.state': {
    callId: string;
    state: 'ringing' | 'up' | 'ended';
    peer: string | null;
    ringGroupId: string | null;
    userId: string | null;
    /**
     * Every user the call is theirs to see (§10.6 "own calls"): the caller, the callee, the
     * answerer and every user with a leg ringing or up right now. Routing data for `api`'s
     * per-subscriber filter on the internal stream only; `publicEnvelope` strips it before a
     * subscriber or a webhook receives the event.
     */
    userIds: string[];
    /**
     * Set while the call's own state is unchanged and it starts or stops being the call of the
     * users `userIds` names (§10.6): `ended` for those it is no longer theirs, its state for those
     * it now is. Delivered to those users alone, never to an admin or a webhook; internal like
     * `userIds`.
     */
    usersOnly?: true;
  };
  'voicemail.new': { voicemailId: string; mailbox: MwiMailbox };
  ooo: {
    scope: Scope;
    active: boolean;
    startsAt: string | null;
    expiresAt: string | null;
  };
  hours: { scope: Scope; open: boolean };
  'trunk.status': { trunkId: string; status: TrunkStatus['status'] };
  'history.appended': { callId: string };
  'backup.started': { targetId: string; runId: string };
  'backup.finished': {
    targetId: string;
    runId: string;
    snapshotId: string;
    bytesAdded: number | null;
    bytesTotal: number | null;
    durationS: number;
  };
  'backup.failed': { targetId: string; runId: string; error: string };
};

export type Event = {
  [T in EventType]: { type: T } & EventFields[T];
}[EventType];

export type Envelope = Event & { id: string; at: string };

/** An `Envelope` as `/events` subscribers and webhooks receive it (§10.6): without the internal
 * routing fields `call.state` carries on `core`'s stream. */
export type PublicEnvelope =
  | Exclude<Envelope, { type: 'call.state' }>
  | Omit<Extract<Envelope, { type: 'call.state' }>, 'userIds' | 'usersOnly'>;

export function publicEnvelope(envelope: Envelope): PublicEnvelope {
  if (envelope.type !== 'call.state') {
    return envelope;
  }
  // The fields §10.6 lists, named one by one so an internal field added later stays internal.
  const { id, at, type, callId, state, peer, ringGroupId, userId } = envelope;
  return { id, at, type, callId, state, peer, ringGroupId, userId };
}
