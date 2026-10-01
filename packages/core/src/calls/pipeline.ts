// Wires Asterisk's ARI events (§9.2 `inbound,<exten>` / `outbound,<exten>` / `leg,<callId>`) to
// the Call aggregate's ring/leg/bridge lifecycle (`legs.ts`), `inbound.ts`'s target resolution,
// `outbound.ts`'s dial resolution and the transfers Asterisk executes (`referTransfers.ts`).
import type { Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel, Logger } from '../ari/types.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import type { Presence } from '../presence.js';
import type { Call } from './call.js';
import { noteHangupRequest } from './callEnd.js';
import type { ActiveBatch } from './groupPickup.js';
import type { Hold } from './hold.js';
import { handleInboundStart } from './inbound.js';
import {
  handleDtmf,
  legWentUp,
  type FindMeAcceptWait,
  type RingResolver
} from './legs.js';
import { handleChannelEnded } from './legsEnded.js';
import { handleOutbound } from './outbound.js';
import type { ParkedEntry } from './parking.js';
import type { PendingTransfers } from './pendingTransfer.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { followTransfers } from './referTransfers.js';
import type { TrunkState } from './trunkState.js';
import type { MailSender } from './voicemail.js';

export type PipelineDeps = {
  ari: AriClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  // The part of `CdrWriter` the pipeline uses, typed structurally so a test can stand in for it.
  cdr: {
    open(call: Call): Promise<void>;
    finish(call: Call): Promise<void>;
    /** §7 level `qos`: notes the call's channels as the ones its `call_qos` rows come from. */
    noteQosLegs?(call: Call): void;
    /** §7 level `qos`: a channel's `ChannelDestroyed`, carrying its `RTPAUDIOQOS`. */
    channelEnded?(channel: Channel): Promise<void>;
    registerLeg?(call: Call, channelId: string): void;
    /** `registerLeg`, resolving once the join is in place (`legOriginate.ts`). */
    joinLeg?(call: Call, channelId: string): Promise<void>;
  };
  // §10.2 "Call recording": the answer and end points below hand every participation to the
  // recorder, which decides per participation whether the effective flag is set. Structural so a
  // test Pipeline can stand one in; `null` for a Pipeline that records nothing.
  recorder?: ParticipationRecorder | null;
  now: () => string;
  // The stack's `TZ` (§11.4 `timezone`: "NULL = stack `TZ`, else UTC"), `CoreEnv.tz`; optional so
  // a test Pipeline that never evaluates opening hours need not supply it (absent = UTC).
  stackTz?: string;
  // The address the stack writes into SIP (`CoreEnv.sipHost`), the host a forwarded leg's
  // `Diversion` entries name (§9.4 "Forwarded calls"); optional, absent = the trunk's own host.
  stackSipHost?: string | null;
  /** How long a created leg may take to enter the app before it counts as not placed
   * (`legOriginate.ts`); tests shorten it. Default `STASIS_WAIT_MS`. */
  legStasisWaitMs?: number;
  // Voicemail deposit's own collaborators (§3.1): optional so a test Pipeline that never deposits
  // a call need not supply them; `main.ts`'s real Pipeline always does.
  db?: Db;
  apiClient?: MailSender;
  // Process-level logging (§10.1 "Emergency calls": an ERROR line while no live emergency trunk
  // exists); optional so a test Pipeline that never needs it can omit it.
  logger?: Logger;
  // Required, `null` until `main.ts` constructs them (§10.2 "Presence and BLF", "Three-way
  // calls"), so a `Pipeline` states at construction whether it carries them: `addParty.ts`'s
  // `addParty` reaches `outboundExternal.ts`'s `originateExternalLeg` through `trunkState` for an
  // external `*5` target, and the ring/answer/end call sites in `outbound.ts`, `legs.ts`,
  // `legsEnded.ts`, `ringGroup.ts` and `ringGroupDial.ts` call `presence.setCallState`.
  trunkState: TrunkState | null;
  presence: Presence | null;
};

// One Pipeline per `core` process, wired directly to its `AriClient`'s event stream so
// constructing it is the only wiring a caller needs to do, the transfers Asterisk executes on SIP
// `REFER` included. The live state below is public so the call modules' functions, taking the
// pipeline as their first argument, can read and write it.
export class Pipeline {
  readonly deps: PipelineDeps;
  readonly callByChannel = new Map<string, Call>();
  readonly pendingRing = new Map<string, RingResolver>();
  readonly findMeTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  readonly pendingFindMeAccept = new Map<string, FindMeAcceptWait>();
  /** The ring-group batch ringing each call right now, by call id (`groupPickup.ts`). */
  readonly activeBatches = new Map<string, ActiveBatch>();
  /** The hold on each conversation, by its bridge (`hold.ts`). */
  readonly holds = new Map<string, Hold>();
  /** The occupied parking slots, by extension, and the slot each parked party's own channel
   * occupies, by channel (`parking.ts`, §10.2 "Call parking"). */
  readonly parkingSlots = new Map<string, ParkedEntry>();
  readonly parkedSlotByChannel = new Map<string, string>();
  /** What each blind transfer's onward call carries into its own (`pendingTransfer.ts`). */
  readonly pendingTransfers: PendingTransfers = {
    entries: new Map(),
    waiters: new Map()
  };

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.deps.ari.on('event', (ev: AriEvent) => {
      // A rejection here is a fault in the routing of one call, never a reason to stop handling
      // the stream. The call's own trace stops where the throw happened and says nothing about
      // it, so the log line is the only account of what went wrong.
      this.routeEvent(ev).catch((error: unknown) => {
        // §7: a call-related line carries the call's correlation id.
        this.deps.logger?.error(
          { err: error, event: ev.type, callId: this.callIdOf(ev) },
          'pipeline: routing failed'
        );
      });
    });
    followTransfers(this);
  }

  /** The call `ev` belongs to, by its channel or, for a leg channel that has not
   * been tracked yet, by the call id its Stasis arguments carry; `null` before any call exists. */
  private callIdOf(ev: AriEvent): string | null {
    const channel = ev.channel as Channel | undefined;
    const tracked =
      channel === undefined ? undefined : this.callByChannel.get(channel.id);
    if (tracked !== undefined) {
      return tracked.id;
    }
    const [kind, callId] =
      (ev.args as (string | undefined)[] | undefined) ?? [];
    return kind === 'leg' && callId !== undefined ? callId : null;
  }

  /**
   * §7 level `qos`: a call's channels are noted before and after each of its events is handled,
   * since handling one may take a leg out of the call (a leg the caller's hangup ends) and put
   * one in (a leg answering), and a channel's own `ChannelDestroyed` is handed on with the
   * `RTPAUDIOQOS` it carries once that note is taken.
   */
  private async routeEvent(ev: AriEvent): Promise<void> {
    const channel = ev.channel as Channel | undefined;
    const before =
      channel === undefined ? undefined : this.callByChannel.get(channel.id);
    if (before !== undefined) {
      this.deps.cdr.noteQosLegs?.(before);
    }
    const qosWritten =
      ev.type === 'ChannelDestroyed' && channel !== undefined
        ? this.deps.cdr.channelEnded?.(channel)
        : undefined;
    await Promise.all([this.dispatch(ev), qosWritten]);
    const after =
      channel === undefined ? undefined : this.callByChannel.get(channel.id);
    for (const call of new Set([before, after])) {
      if (call !== undefined) {
        this.deps.cdr.noteQosLegs?.(call);
      }
    }
  }

  private async dispatch(ev: AriEvent): Promise<void> {
    if (ev.type === 'StasisStart') {
      await this.handleStasisStart(ev);
      return;
    }
    if (ev.type === 'ChannelStateChange') {
      const channel = ev.channel as Channel;
      if (channel.state === 'Up') {
        await legWentUp(this, channel.id);
      }
      return;
    }
    if (ev.type === 'ChannelDtmfReceived') {
      handleDtmf(this, ev);
      return;
    }
    if (ev.type === 'ChannelHangupRequest') {
      const call = this.callByChannel.get((ev.channel as Channel).id);
      if (call !== undefined) {
        noteHangupRequest(call, ev);
      }
      return;
    }
    if (ev.type === 'ChannelDestroyed' || ev.type === 'StasisEnd') {
      await handleChannelEnded(this, ev);
    }
  }

  async handleStasisStart(ev: AriEvent): Promise<void> {
    const args = (ev.args as string[] | undefined) ?? [];
    const kind = args[0];
    if (kind === 'inbound') {
      await handleInboundStart(this, ev);
      return;
    }
    if (kind === 'outbound') {
      await handleOutbound(this, ev);
      return;
    }
    // An originated leg enters the app as it answers; a created one (`legOriginate.ts`) as it is
    // created, before it is dialled, and its answer is the `ChannelStateChange` to `Up`.
    const channel = ev.channel as Channel;
    if (kind === 'leg' && channel.state === 'Up') {
      await legWentUp(this, channel.id);
    }
    // A `snoop,<channelId>` entry is the recorder's own spy channel (§10.2): `Recorder` holds its
    // id from the originate and drives its recording directly, so the pipeline leaves it alone.
  }

  registerCall(call: Call): void {
    this.callByChannel.set(call.callerChannelId, call);
  }
}
