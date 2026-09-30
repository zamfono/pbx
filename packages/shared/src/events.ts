/**
 * The realtime event union delivered on the `/events` WebSocket and to webhooks (§10.6). Every
 * event also carries `id` (uuid v7) and `at` (ISO), added by the emitter, as `Envelope`.
 */
export type Scope =
  'tenant' | `user:${string}` | `ringGroup:${string}` | `menu:${string}`;

export type Event =
  | {
      type: 'presence';
      userId: string;
      status: 'available' | 'busy' | 'offline' | 'dnd';
      peer: string | null;
      ringGroupId: string | null;
    }
  | {
      type: 'call.state';
      callId: string;
      state: 'ringing' | 'up' | 'ended';
      peer: string | null;
      ringGroupId: string | null;
      userId: string | null;
      /**
       * Every user the call is theirs to see (§10.6 "own calls"): the caller, the callee, the
       * answerer and every user one of its legs rang or connected. Routing data for `api`'s
       * per-subscriber filter on the internal stream only; `publicEnvelope` strips it before a
       * subscriber or a webhook receives the event.
       */
      userIds: string[];
    }
  | {
      type: 'voicemail.new';
      voicemailId: string;
      mailbox: `user:${string}` | `ringGroup:${string}`;
    }
  | {
      type: 'ooo';
      scope: Scope;
      active: boolean;
      startsAt: string | null;
      expiresAt: string | null;
    }
  | { type: 'hours'; scope: Scope; open: boolean }
  | {
      type: 'trunk.status';
      trunkId: string;
      status: 'registered' | 'unreachable' | 'unmonitored' | 'unknown';
    }
  | { type: 'history.appended'; callId: string }
  | { type: 'backup.started'; targetId: string; runId: string }
  | {
      type: 'backup.finished';
      targetId: string;
      runId: string;
      snapshotId: string;
      bytesAdded: number | null;
      bytesTotal: number | null;
      durationS: number;
    }
  | { type: 'backup.failed'; targetId: string; runId: string; error: string };

export type Envelope = Event & { id: string; at: string };

/** An `Envelope` as `/events` subscribers and webhooks receive it (§10.6): without the internal
 * routing field `call.state` carries on `core`'s stream. */
export type PublicEnvelope =
  | Exclude<Envelope, { type: 'call.state' }>
  | Omit<Extract<Envelope, { type: 'call.state' }>, 'userIds'>;

export function publicEnvelope(envelope: Envelope): PublicEnvelope {
  if (envelope.type !== 'call.state') {
    return envelope;
  }
  // The fields §10.6 lists, named one by one so an internal field added later stays internal.
  const { id, at, type, callId, state, peer, ringGroupId, userId } = envelope;
  return { id, at, type, callId, state, peer, ringGroupId, userId };
}
