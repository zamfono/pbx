// Wires Asterisk's ARI events (§9.2 `inbound,<exten>` / `outbound,<exten>` / `leg,<callId>`) to
// the Call aggregate's ring/leg/bridge lifecycle (`legs.ts`), `inbound.ts`'s target resolution,
// `outbound.ts`'s dial resolution and the transfers Asterisk executes (`referTransfers.ts`).
import { isEvent, type AriEvent, type AriEventOf } from '../ari/events.js';
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
import type { PipelineDeps } from './pipelineDeps.js';
import { followTransfers } from './referTransfers.js';
import { refuseCall, startsCall, WindDowns } from './windDown.js';

// One Pipeline per `core` process, wired directly to its `AriClient`'s event stream so
// constructing it is the only wiring a caller needs to do, the transfers Asterisk executes on SIP
// `REFER` included. The live state below is public so the call modules' functions, taking the
// pipeline as their first argument, can read and write it.
export class Pipeline {
  readonly deps: PipelineDeps;
  readonly callByChannel = new Map<string, Call>();
  /** The calls with no caller channel (`Call.callerChannelId` `null`), by id: reachable for the
   * live-call actions until they get one (`registerCall`) or end (`finishCall`). */
  readonly channelless = new Map<string, Call>();
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

  /** The events whose handling is in progress, by the promise that settles as it ends. */
  private readonly handlingInProgress = new Map<Promise<void>, AriEvent>();
  /** The calls `drain` is ending. */
  readonly windDowns = new WindDowns();
  /** Set by `drain`: a call's first event releases its caller (`refuseCall`), and a call made
   * reachable from then on is wound down at once. */
  private draining = false;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.deps.ari.on('event', (ev: AriEvent) => {
      // A rejection here is a fault in the routing of one call, never a reason to stop handling
      // the stream. The call's own trace stops where the throw happened and says nothing about
      // it, so the log line is the only account of what went wrong.
      const handled = (
        this.draining && startsCall(ev)
          ? refuseCall(this, ev.channel)
          : this.routeEvent(ev)
      )
        .catch((error: unknown) => {
          // §7: a call-related line carries the call's correlation id.
          this.deps.logger.error(
            { err: error, event: ev.type, callId: this.callIdOf(ev) },
            'pipeline: routing failed'
          );
        })
        .finally(() => {
          this.handlingInProgress.delete(handled);
        });
      this.handlingInProgress.set(handled, ev);
    });
    followTransfers(this);
  }

  /** Whether `drain` has begun: from then on no leg is placed (`legOriginate.ts`). */
  get stopping(): boolean {
    return this.draining;
  }

  /** The events whose handling is in progress, with the call each belongs to. */
  get handling(): { event: string; callId: string | null }[] {
    return [...this.handlingInProgress.values()].map(ev => ({
      event: ev.type,
      callId: this.callIdOf(ev)
    }));
  }

  /** Whether a call of this process holds `channelId`, or an event on it is being handled. */
  tracks(channelId: string): boolean {
    return (
      this.callByChannel.has(channelId) ||
      [...this.handlingInProgress.values()].some(
        ev => ev.channel?.id === channelId
      )
    );
  }

  /** Resolves once no event's handling nor call's wind-down is in progress, those that start
   * while it waits included. */
  async idle(): Promise<void> {
    const pending = [
      ...this.handlingInProgress.keys(),
      ...this.windDowns.pending
    ];
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending);
    await this.idle();
  }

  /**
   * Starts no further calls, winds every call down (`windDown.ts`) and resolves once that and
   * the event handling in progress have finished. The events of the calls are still routed: a
   * wind-down and the handling it cuts short finish on them.
   */
  drain(): Promise<void> {
    this.draining = true;
    for (const call of [
      ...this.callByChannel.values(),
      ...this.channelless.values()
    ]) {
      this.windDowns.start(this, call);
    }
    return this.idle();
  }

  /** The call `ev` belongs to, by its channel or, for a leg channel that has not
   * been tracked yet, by the call id its Stasis arguments carry; `null` before any call exists. */
  private callIdOf(ev: AriEvent): string | null {
    const channel = ev.channel;
    const tracked =
      channel === undefined ? undefined : this.callByChannel.get(channel.id);
    if (tracked !== undefined) {
      return tracked.id;
    }
    if (!isEvent(ev, 'StasisStart')) {
      return null;
    }
    const [kind, callId] = ev.args;
    return kind === 'leg' && callId !== undefined ? callId : null;
  }

  /**
   * §7 level `qos`: a call's channels are noted before and after each of its events is handled,
   * since handling one may take a leg out of the call (a leg the caller's hangup ends) and put
   * one in (a leg answering), and a channel's own `ChannelDestroyed` is handed on with the
   * `RTPAUDIOQOS` it carries once that note is taken.
   */
  private async routeEvent(ev: AriEvent): Promise<void> {
    const channel = ev.channel;
    const before =
      channel === undefined ? undefined : this.callByChannel.get(channel.id);
    if (before !== undefined) {
      this.deps.cdr.noteQosLegs(before);
    }
    const qosWritten =
      ev.type === 'ChannelDestroyed' && channel !== undefined
        ? this.deps.cdr.channelEnded(channel)
        : undefined;
    await Promise.all([this.dispatch(ev), qosWritten]);
    const after =
      channel === undefined ? undefined : this.callByChannel.get(channel.id);
    for (const call of new Set([before, after])) {
      if (call !== undefined) {
        this.deps.cdr.noteQosLegs(call);
      }
    }
  }

  private async dispatch(ev: AriEvent): Promise<void> {
    if (isEvent(ev, 'StasisStart')) {
      await this.handleStasisStart(ev);
      return;
    }
    if (isEvent(ev, 'ChannelStateChange')) {
      const channel = ev.channel;
      if (channel.state === 'Up') {
        await legWentUp(this, channel.id);
      }
      return;
    }
    if (isEvent(ev, 'ChannelDtmfReceived')) {
      handleDtmf(this, ev);
      return;
    }
    if (isEvent(ev, 'ChannelHangupRequest')) {
      const call = this.callByChannel.get(ev.channel.id);
      if (call !== undefined) {
        noteHangupRequest(call, ev);
      }
      return;
    }
    if (isEvent(ev, 'ChannelDestroyed', 'StasisEnd')) {
      await handleChannelEnded(this, ev);
    }
  }

  async handleStasisStart(ev: AriEventOf<'StasisStart'>): Promise<void> {
    const kind = ev.args[0];
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
    const channel = ev.channel;
    if (kind === 'leg' && channel.state === 'Up') {
      await legWentUp(this, channel.id);
    }
    // A `snoop,<channelId>` entry is the recorder's own spy channel (§10.2): `Recorder` holds its
    // id from the originate and drives its recording directly, so the pipeline leaves it alone.
  }

  /** Makes `call` reachable: by its caller channel, or by its id while it has none. One made
   * reachable during `drain` is wound down at once. */
  registerCall(call: Call): void {
    if (call.callerChannelId === null) {
      this.channelless.set(call.id, call);
    } else {
      this.channelless.delete(call.id);
      this.callByChannel.set(call.callerChannelId, call);
    }
    if (this.draining) {
      this.windDowns.start(this, call);
    }
  }

  /** Writes `call`'s history entry (`CdrWriter.finish`): every way a call ends comes through here,
   * so a call with no caller channel leaves `channelless` with it. */
  async finishCall(call: Call): Promise<void> {
    this.channelless.delete(call.id);
    await this.deps.cdr.finish(call);
  }
}
