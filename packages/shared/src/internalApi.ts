/**
 * The core↔api internal API (§3, §3.1). `core` serves these on its internal HTTP+WS port; `api`
 * serves `/internal/mail`.
 */
export type ReloadKind = 'pjsip' | 'dialplan' | 'moh';

/** `POST /internal/configChanged` → 204, once core has dropped its config cache, reloaded `reload`
 * and recomputed every user's presence from the new configuration (§3.1, §10.2). */
export type ConfigChangedRequest = { reload: ReloadKind[] };

export type TrunkStatus = {
  status: 'registered' | 'unreachable' | 'unknown';
  statusChangedAt: string | null;
};

export type LiveCall = {
  callId: string;
  direction: 'inbound' | 'outbound' | 'internal';
  from: string;
  to: string;
  state: 'ringing' | 'up';
  startedAt: string;
  ringGroupId: string | null;
  userIds: string[];
};

export type Presence = {
  status: 'available' | 'busy' | 'offline' | 'dnd';
  peer: string | null;
  ringGroupId: string | null;
  since: string;
};

/** `GET /internal/state`. */
export type StateResponse = {
  calls: LiveCall[];
  trunks: Record<string, TrunkStatus>;
  /** Active legs per trunk id (§9.4 "Channels"); a trunk carrying none is absent. */
  trunkChannels: Record<string, number>;
  presence: Record<string, Presence>;
  /** Live devices with a reachable contact right now (§7 "registered devices", §9.3). */
  registeredDevices: number;
  /** Recording mixes failed since `core` started (§10.2 "Best effort", §7). */
  recordingMixFailures: number;
};

/** `POST /internal/calls` → 201 `{ callId }` | 409 RFC 9457 problem whose `detail` is `'noRegisteredDevice'` (§10.2).
 * A refused call action answers its status as a problem whose `detail` is the reason. */
export type OriginateRequest = {
  userId: string;
  target: string;
  actorUserId: string;
  requestId: string;
};

/** `POST /internal/calls/{id}/transfer` → 204. */
export type TransferRequest = { target: string; actorUserId: string };

/** `POST /internal/calls/{id}/pickup` → 204. */
export type PickupRequest = { userId: string; actorUserId: string };

/** `POST /internal/calls/{id}/hangup` → 204. */
export type HangupRequest = { actorUserId: string };

/** `POST /internal/mwi/{mailbox}` → 204: core re-reads the mailbox's counts and pushes MWI (§3.1, §9.3). */
export type MwiMailbox = `user:${string}` | `ringGroup:${string}`;

/** `GET /healthz` (200 iff `ok`). */
export type CoreHealth = { ok: boolean; ari: boolean; db: boolean };

// WS /internal/events: server sends Envelope JSON frames, no auth (internal network).

export type MailKind = 'voicemail' | 'missedCall' | 'setup' | 'reset';

/** `POST /internal/mail` (api) → 202; api rejects a request carrying `X-Forwarded-For` with 404 (§3.1). */
export type MailRequest =
  | {
      kind: 'voicemail';
      /** The call the mail is about, for the log lines of its send (§7); absent for a test mail. */
      callId?: string;
      to: { userId: string } | { ringGroupId: string };
      values: {
        callerNumber: string;
        callerName: string;
        mailboxName: string;
        receivedAt: string;
        durationS: number;
      };
      attachmentPath: string;
    }
  | {
      kind: 'missedCall';
      /** The call the mail is about, for the log lines of its send (§7); absent for a test mail. */
      callId?: string;
      to: { userId: string };
      values: {
        callerNumber: string;
        callerName: string;
        receivedAt: string;
        didLabel: string;
      };
    };
