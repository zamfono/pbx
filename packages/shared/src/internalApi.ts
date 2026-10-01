/**
 * The core↔api internal API (§3, §3.1). `core` serves these on its internal HTTP+WS port; `api`
 * serves `/internal/mail`.
 */
import type { Envelope } from './events.js';
import type { ZamfonoVersion } from './version.js';

export type ReloadKind = 'pjsip' | 'dialplan' | 'moh';

/** `POST /internal/configChanged` → 204, once core has dropped its config cache, reloaded `reload`
 * and recomputed every user's presence from the new configuration (§3.1, §10.2). */
export type ConfigChangedRequest = { reload: ReloadKind[] };

export type TrunkStatus = {
  status: 'registered' | 'unreachable' | 'unmonitored' | 'unknown';
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
  /** The users whose call this is to see (§10.3 "Live calls"): the caller, the callee, the
   * answerer and every user with a leg ringing or up right now. */
  userIds: string[];
  /** The users who may end or transfer it (§10.3 "Live calls"): the caller and every user with a
   * leg up in it. For `api`'s check alone; `calls.list` leaves it out. */
  connectedUserIds: string[];
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
  /**
   * Channels Asterisk holds right now, read from ARI when served: every leg, a parked party, a
   * voicemail deposit, a menu and a recording's snoop channels alike; `null` while ARI does not
   * answer (§6.4 "Maintenance gate").
   */
  asteriskChannels: number | null;
  /** Participations being recorded or still being mixed into their file (§10.2, §6.4). */
  recordingsInProgress: number;
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

/**
 * `GET /internal/version` (§7 "Version"): what `core` runs, since when, and since when the
 * Asterisk it is connected to runs. `asteriskStartedAt` is `null` while ARI is down or does not
 * answer; a new value means a new Asterisk, which holds none of the registrations the one before
 * held (§10.4 "After a restart").
 */
export type CoreVersionResponse = ZamfonoVersion & {
  startedAt: string;
  asteriskStartedAt: string | null;
};

/** `GET /healthz` (200 iff `ok`). */
export type CoreHealth = { ok: boolean; ari: boolean; db: boolean };

/**
 * A frame for `api` alone on `core`'s internal stream, never relayed to `/events` or webhooks:
 * the ARI connection opened to the Asterisk that started at `asteriskStartedAt`, a new one after
 * an Asterisk restart (§10.4 "After a restart").
 */
export type AsteriskStartedFrame = {
  type: 'asterisk.started';
  asteriskStartedAt: string;
};

/** WS /internal/events: every JSON frame `core` sends, no auth (internal network). */
export type CoreStreamFrame = Envelope | AsteriskStartedFrame;

export type MailKind =
  | 'voicemail'
  | 'missedCall'
  | 'setup'
  | 'reset'
  | 'updateFailed'
  | 'breakingUpdate';

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
