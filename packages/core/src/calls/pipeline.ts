// Wires Asterisk's ARI events (§9.2 `inbound,<exten>` / `leg,<callId>`) to the Call aggregate's
// ring/leg/bridge lifecycle (`legs.ts`) and `inbound.ts`'s target-resolution logic.
import type { Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel, Logger } from '../ari/types.js';
import { ConfigCache, EventBus, StateStore } from '../internal/server.js';
import type { Presence } from '../presence.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { Call, Owner } from './call.js';
import { noteHangupRequest } from './callEnd.js';
import type { Diversion } from './forwardContext.js';
import { enterTarget, handleInboundStart } from './inbound.js';
import {
  handleChannelEnded,
  handleDtmf,
  legWentUp,
  type FindMeAcceptWait,
  type RingResolver
} from './legs.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { ringUser } from './ringUser.js';
import { runTarget } from './runTarget.js';
import type { TrunkState } from './trunkState.js';
import { deposit, type DepositReason, type MailSender } from './voicemail.js';

export { ConfigCache, EventBus, StateStore };

export type PipelineDeps = {
  ari: AriClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  // A minimal, structural stand-in for Task 32's `CdrWriter`, ahead of that task's own file.
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
  // --- Task 31 ---
  // Required, `null` until `main.ts` constructs them (§10.2 "Presence and BLF", "Three-way
  // calls"), so a `Pipeline` states at construction whether it carries them: `addParty.ts`'s
  // `addParty` reaches `outboundExternal.ts`'s `originateExternalLeg` through `trunkState` for an
  // external `*5` target, and the ring/answer/end call sites in `outbound.ts`, `legs.ts`,
  // `legsEnded.ts`, `ringGroup.ts` and `ringGroupDial.ts` call `presence.setCallState`.
  trunkState: TrunkState | null;
  presence: Presence | null;
  // --- end Task 31 ---
};

// One Pipeline per `core` process, wired directly to its `AriClient`'s event stream so
// constructing it is the only wiring a caller needs to do. The ring/leg/bridge state below is
// public so `legs.ts`'s functions, taking `this` as their first argument, can read and write it.
export class Pipeline {
  readonly deps: PipelineDeps;
  readonly callByChannel = new Map<string, Call>();
  readonly pendingRing = new Map<string, RingResolver>();
  readonly findMeTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  readonly pendingFindMeAccept = new Map<string, FindMeAcceptWait>();
  // Set by Task 30's wiring (`setOutboundHandler`); `null` until then, so an `outbound,<exten>`
  // Stasis entry is a no-op rather than a crash.
  private outboundHandler: ((ev: AriEvent) => Promise<void>) | null = null;

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
      await this.outboundHandler?.(ev);
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

  /** Routes `exten` as dialled from `channel`, a device channel already in the app and answered
   * (an API pickup's, `actions.ts`), exactly as its own `outbound,<exten>` entry would be. */
  async dialFrom(channel: Channel, exten: string): Promise<void> {
    await this.outboundHandler?.({
      type: 'StasisStart',
      timestamp: new Date().toISOString(),
      application: 'zamfono',
      args: ['outbound', exten],
      channel
    });
  }

  /** Wires Task 30's `handleOutbound` for `outbound,<exten>` Stasis entries (§9.2). */
  setOutboundHandler(handler: (ev: AriEvent) => Promise<void>): void {
    this.outboundHandler = handler;
  }

  registerCall(call: Call): void {
    this.callByChannel.set(call.callerChannelId, call);
  }

  /** §10.1 step 7, dialling an external target as `asUser`, the forwarding user, `diversion` the
   * forward hop it is, `null` for none (`runTarget.ts`). */
  async runTarget(
    call: Call,
    target: ForwardTarget,
    asUser: string | null,
    diversion: Diversion | null = null
  ): Promise<void> {
    await runTarget(this, call, target, asUser, diversion);
  }

  /** Entry's hop-free re-entry (§10.1 step 1/6): a matched menu option or a menu's live-extension
   * match, neither of which counts a hop (§10.1 step 7). */
  async enterTarget(
    call: Call,
    target: ForwardTarget,
    asUser: string | null
  ): Promise<void> {
    await enterTarget(this, call, target, asUser);
  }

  async ringUser(call: Call, userId: string): Promise<void> {
    await ringUser(this, call, userId);
  }

  /** §10.1 steps 4 and 5: the mailbox outcome of a ring that went unanswered. Routed through the
   * pipeline because `call.ts` holds those outcomes and `voicemail.ts` reads `call.ts`. */
  async deposit(
    call: Call,
    mailbox: Owner,
    reason: DepositReason | null = null
  ): Promise<void> {
    await deposit(this, call, mailbox, reason);
  }
}
