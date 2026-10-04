/**
 * The core↔api internal API (§3, §3.1). `core` serves these on its internal HTTP+WS port; `api`
 * serves `/internal/mail`. Each request body `core` serves is a zod schema here, which `core` parses
 * it with; its type is the schema's.
 */
import { z } from 'zod';

import type { CallDirection, PresenceStatus } from './columnValues.js';
import type { Envelope } from './events.js';
import type { MailboxOwner } from './mwiMailbox.js';
import type { ZamfonoVersion } from './version.js';

export const reloadKindSchema = z.enum(['pjsip', 'dialplan', 'moh']);
export type ReloadKind = z.infer<typeof reloadKindSchema>;

/** `POST /internal/configChanged` → 204, once core has dropped its config cache, reloaded `reload`
 * and recomputed every user's presence from the new configuration (§3.1, §10.2). */
export const configChangedRequestSchema = z.object({
  reload: z.array(reloadKindSchema)
});
export type ConfigChangedRequest = z.infer<typeof configChangedRequestSchema>;

export type TrunkStatus = {
  status: 'registered' | 'unreachable' | 'unmonitored' | 'unknown';
  statusChangedAt: string | null;
};

export type LiveCall = {
  callId: string;
  direction: CallDirection;
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
  status: PresenceStatus;
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
export const originateRequestSchema = z.object({
  userId: z.string(),
  target: z.string(),
  actorUserId: z.string(),
  requestId: z.string(),
  /** This call's own CLIR, as `#31#`/`*31#` give it (§9.4 "Anonymous calls (CLIR)"); absent,
   * the user's, trunk's or tenant's default applies. */
  clir: z.boolean().optional()
});
export type OriginateRequest = z.infer<typeof originateRequestSchema>;

/** `POST /internal/calls/{id}/transfer` → 204; with `voicemail`, 422 `noMailbox` for a `target`
 * no user or ring group owns. */
export const transferRequestSchema = z.object({
  target: z.string(),
  actorUserId: z.string(),
  /** Deposits the transferee in `target`'s mailbox without ringing, as `*97<ext>` does (§9.3). */
  voicemail: z.boolean().optional()
});
export type TransferRequest = z.infer<typeof transferRequestSchema>;

/** A request naming the user it acts for, and the actor. */
const forUserRequestSchema = z.object({
  userId: z.string(),
  actorUserId: z.string()
});

/** A request naming its target, and the actor. */
const targetRequestSchema = z.object({
  target: z.string(),
  actorUserId: z.string()
});

/** A request naming only the actor. */
const actorRequestSchema = z.object({ actorUserId: z.string() });

/** `POST /internal/calls/{id}/pickup` → 204. */
export const pickupRequestSchema = forUserRequestSchema;
export type PickupRequest = z.infer<typeof pickupRequestSchema>;

/** `POST /internal/calls/{id}/hangup` → 204. */
export const hangupRequestSchema = actorRequestSchema;
export type HangupRequest = z.infer<typeof hangupRequestSchema>;

/** `POST /internal/calls/{id}/park` → 200 `{ slot }`: `userId`, who must be in the call, parks
 * its other party (§10.2 "Call parking"); 409 `notInCall`, `notBridged` or `noFreeSlot`. */
export const parkRequestSchema = forUserRequestSchema;
export type ParkRequest = z.infer<typeof parkRequestSchema>;

/** One occupied parking slot (§10.2 "Call parking"), as every user's BLF shows it. */
export type ParkedCall = {
  slot: string;
  callId: string;
  /** The parked party's number as the phones show it; `null` when the caller withheld it. */
  caller: string | null;
  parkedAt: string;
  parkedByUserId: string;
};

/** `GET /internal/parking`: the parked calls, by slot. */
export type ParkingResponse = { parked: ParkedCall[] };

/** `POST /internal/calls/{id}/parties` → 201 `{ callId }`, the added leg's own call (§10.2
 * "Three-way calls"). A refused action answers its status as a problem whose `detail` is the
 * reason, a target no party answers on (`invalidTarget`) with 422. */
export const addPartyRequestSchema = targetRequestSchema;
export type AddPartyRequest = z.infer<typeof addPartyRequestSchema>;

/** `POST /internal/calls/{id}/consult` → 201 `{ callId }`, the consultation call. */
export const consultRequestSchema = targetRequestSchema;
export type ConsultRequest = z.infer<typeof consultRequestSchema>;

/** `POST /internal/calls/{id}/attendedTransfer` → 204: the held party joins the consultation
 * `toCallId` in the actor's place (§10.1 "Transfers and pickup"). */
export const attendedTransferRequestSchema = z.object({
  toCallId: z.string(),
  actorUserId: z.string()
});
export type AttendedTransferRequest = z.infer<
  typeof attendedTransferRequestSchema
>;

/** `POST /internal/calls/{id}/hold` and `POST /internal/calls/{id}/resume` → 204. */
export const holdRequestSchema = actorRequestSchema;
export type HoldRequest = z.infer<typeof holdRequestSchema>;

/** `POST /internal/calls/{id}/decline` → 204: the actor's own legs ringing for the call end as
 * declined (§10.1 steps 4 and 5). */
export const declineRequestSchema = actorRequestSchema;
export type DeclineRequest = z.infer<typeof declineRequestSchema>;

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
      to: MailboxOwner;
      values: {
        callerNumber: string;
        callerName: string;
        mailboxName: string;
        receivedAt: string;
        durationS: number;
      };
      /** The recording, under `/media/voicemail/` (§11.6); absent for a test mail. */
      attachmentPath?: string;
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
