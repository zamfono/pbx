/**
 * A call's `call_qos` rows (§7 level `qos`): each leg's RTCP summary, as Asterisk leaves it on the
 * leg's channel when it hangs up. Its own module so `cdr.ts` stays under the repository's
 * `max-lines` lint rule.
 *
 * Asterisk sets `RTPAUDIOQOS` on a channel with an RTP instance as it hangs up, whichever side
 * ends it (`ast_rtp_instance_set_stats_vars`: chan_pjsip as a BYE ends the session and as the
 * channel is hung up, ARI's `DELETE /channels/{id}` before its hangup request), and publishes
 * the channel's `ChannelDestroyed` only after that; ari.conf's `channelvars` makes every event
 * carry the variable in `channel.channelvars`. So each leg's row comes from its own
 * `ChannelDestroyed`, pushed to the core, and nothing reads a channel's statistics while it runs.
 *
 * Which calls a channel's row belongs to is noted while the channel is part of them (`note`):
 * the caller's own channel from the start, a leg once it is up. A channel may end before its call
 * is written (the party who hangs up first), whose row is held until `write`, or after (a leg
 * the core hangs up as the call ends), whose row is written as its channel goes.
 *
 * A channel whose `ChannelDestroyed` never reaches the core (an event lost while the ARI
 * connection was down) would otherwise be waited for until the process ends. So a call's channels
 * still awaited a while after its write, and every awaited channel once the ARI connection opens
 * again, are checked against the channels Asterisk still holds, and one it no longer holds is let
 * go without a row, unless the RTCP reports Asterisk mirrored over HEP measured it.
 *
 * Those reports (`rtcpReport.ts`, `rtcpQos.ts`) fill each figure the summary leaves null, the
 * summary winning every figure it measured: both come from the same reports, and the summary is
 * the one Asterisk kept to the end of the leg.
 */
import type { CallLogLevel, Db, QosRole } from '@zamfono/shared';

import { logFailure } from './ari/failures.js';
import type { Channel, ChannelsApi, Logger } from './ari/types.js';
import type { Call } from './calls/call.js';
import {
  parseRtpAudioQos,
  qosFigures,
  RTP_AUDIO_QOS_VARIABLE,
  type QosFigures
} from './qosFigures.js';
import { qosTargets, type QosTarget } from './qosTargets.js';
import { RtcpQos, withRtcp } from './rtcpQos.js';

// §7: `call_qos` is written at diagnostics level `qos` and `sip`, never at `none`/`events`.
const QOS_ELIGIBLE_LEVELS: ReadonlySet<CallLogLevel> = new Set(['qos', 'sip']);

// How long after a call's write its channels still awaited are checked against Asterisk's: the
// legs the core hangs up as the call ends are gone within moments, and their `ChannelDestroyed`
// follows; one still missing by then was lost, unless its channel lives on in another call (a
// transferred caller), which keeps it awaited.
const QOS_TAIL_MS = 10_000;

/** One `call_qos` row. */
type QosRow = QosTarget & QosFigures & { callId: string };

/** One call's channels whose rows are still to come, those that have ended, the rows that came
 * before the call was written, and whether it was. */
type Tracked = {
  call: Call;
  roles: Map<string, QosRole>;
  ended: Set<string>;
  held: QosRow[];
  written: boolean;
};

function eligible(call: Call): boolean {
  return QOS_ELIGIBLE_LEVELS.has(call.log.level);
}

/** The rows `CdrWriter` collects from its calls' channels as they end, and their write. */
export class QosRows {
  private readonly db: Db;
  private readonly channels: Pick<ChannelsApi, 'list'>;
  private readonly log: Logger;
  private readonly tailMs: number;
  private readonly rtcp: RtcpQos;
  private readonly calls = new Map<string, Tracked>();
  // Every tracked call a channel's row belongs to: a transfer makes one channel part of two.
  private readonly callsByChannel = new Map<string, Set<string>>();

  constructor(
    db: Db,
    channels: Pick<ChannelsApi, 'list'>,
    log: Logger,
    tailMs = QOS_TAIL_MS,
    rtcp = new RtcpQos()
  ) {
    this.db = db;
    this.channels = channels;
    this.log = log;
    this.tailMs = tailMs;
    this.rtcp = rtcp;
  }

  /** How many channels' rows are still awaited; a test seam. */
  get awaited(): number {
    return this.callsByChannel.size;
  }

  /**
   * Notes `call`'s channels as they are now, each under its role: the caller's own and every leg
   * that is up. Safe to call any number of times for a call; a channel keeps the role it was last
   * noted with, and a leg noted once keeps its row when it leaves the call before it ends (a
   * transferrer, §10.1). Called whatever the level, since routing can still raise it (§7); the
   * level decides only at the write.
   */
  note(call: Call): void {
    const targets = qosTargets(call);
    if (targets.length === 0 && !this.calls.has(call.id)) {
      return;
    }
    const tracked = this.calls.get(call.id) ?? {
      call,
      roles: new Map<string, QosRole>(),
      ended: new Set<string>(),
      held: [],
      written: false
    };
    this.calls.set(call.id, tracked);
    for (const target of targets) {
      // A channel that has ended keeps the row it had; the caller's stays the call's caller.
      if (tracked.ended.has(target.channelId)) {
        continue;
      }
      tracked.roles.set(target.channelId, target.role);
      const calls = this.callsByChannel.get(target.channelId) ?? new Set();
      calls.add(call.id);
      this.callsByChannel.set(target.channelId, calls);
    }
  }

  /**
   * A channel's `ChannelDestroyed`: its row, from the `RTPAUDIOQOS` the event carries and the
   * channel's RTCP reports, for every call it was noted for, held for a call not written yet and
   * written now for one that was. A channel without an RTP instance (a Local channel) has no row.
   * A leg whose instance saw no packet still has one, of nothing measured but a received count of
   * 0: a bridged leg without media is a finding of its own (no audio).
   */
  async channelEnded(channel: Channel): Promise<void> {
    const stat = parseRtpAudioQos(
      channel.channelvars?.[RTP_AUDIO_QOS_VARIABLE]
    );
    await this.insert(
      this.settle(channel.id, stat === null ? null : qosFigures(stat))
    );
  }

  /**
   * Lets go of every awaited channel Asterisk no longer holds, as the ARI connection opens again:
   * a `ChannelDestroyed` sent while it was down never arrives; so do the Call-ID joins of such
   * channels (`RtcpQos`). Only channels awaited or joined before the listing count, since one
   * noted after it may be newer than the list.
   */
  async resync(): Promise<void> {
    const awaited = [...this.callsByChannel.keys()];
    const joined = this.rtcp.joined();
    if (awaited.length === 0 && joined.length === 0) {
      return;
    }
    const live = await this.liveChannels();
    await this.settleGone(awaited, live);
    this.rtcp.release(joined, live);
  }

  private async liveChannels(): Promise<ReadonlySet<string>> {
    return new Set((await this.channels.list()).map(({ id }) => id));
  }

  /** Settles each of `channelIds` still awaited that is not `live`, with the row its RTCP reports
   * give, if any. */
  private async settleGone(
    channelIds: readonly string[],
    live: ReadonlySet<string>
  ): Promise<void> {
    const gone = channelIds.filter(channelId => !live.has(channelId));
    await this.insert(gone.flatMap(channelId => this.settle(channelId, null)));
  }

  /** `channelId` ended with the `summary` its `RTPAUDIOQOS` gives: it is no longer awaited for
   * any call, and the rows it gives, with its RTCP reports, are returned for a call already
   * written, held for one that is not. */
  private settle(channelId: string, summary: QosFigures | null): QosRow[] {
    const figures = withRtcp(summary, this.rtcp.take(channelId));
    const callIds = this.callsByChannel.get(channelId);
    if (callIds === undefined) {
      return [];
    }
    this.callsByChannel.delete(channelId);
    const now: QosRow[] = [];
    for (const callId of callIds) {
      const tracked = this.calls.get(callId);
      const role = tracked?.roles.get(channelId);
      if (tracked === undefined || role === undefined) {
        continue;
      }
      tracked.roles.delete(channelId);
      tracked.ended.add(channelId);
      if (figures !== null) {
        const row = { callId, channelId, role, ...figures };
        if (!tracked.written) {
          tracked.held.push(row);
        } else if (eligible(tracked.call)) {
          now.push(row);
        }
      }
      this.forgetIfDone(tracked);
    }
    return now;
  }

  /** Writes `call`'s rows whose channels have ended, and has every row still to come written as
   * its channel ends; below level `qos`, none. */
  async write(call: Call): Promise<void> {
    this.note(call);
    const tracked = this.calls.get(call.id);
    if (tracked === undefined) {
      return;
    }
    tracked.written = true;
    const rows = tracked.held;
    tracked.held = [];
    if (!eligible(call)) {
      this.forget(tracked);
      return;
    }
    this.forgetIfDone(tracked);
    this.checkAfterTail(tracked);
    await this.insert(rows);
  }

  /** Once the tail has passed, lets go of `tracked`'s channels still awaited that Asterisk no
   * longer holds; a failed listing leaves them to the next reconnect's `resync`. */
  private checkAfterTail(tracked: Tracked): void {
    if (tracked.roles.size === 0) {
      return;
    }
    const timer = setTimeout(() => {
      const awaited = [...tracked.roles.keys()];
      this.liveChannels()
        .then(async live => this.settleGone(awaited, live))
        .catch(logFailure(this.log, 'qos settle'));
    }, this.tailMs);
    timer.unref();
  }

  /** Stops waiting for `tracked`'s channels: below level `qos` nothing of it is written. */
  private forget(tracked: Tracked): void {
    for (const channelId of tracked.roles.keys()) {
      const calls = this.callsByChannel.get(channelId);
      calls?.delete(tracked.call.id);
      if (calls?.size === 0) {
        this.callsByChannel.delete(channelId);
      }
    }
    this.calls.delete(tracked.call.id);
  }

  private forgetIfDone(tracked: Tracked): void {
    if (tracked.written && tracked.roles.size === 0) {
      this.calls.delete(tracked.call.id);
    }
  }

  private async insert(rows: QosRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db.insertInto('callQos').values(rows).execute();
  }
}
