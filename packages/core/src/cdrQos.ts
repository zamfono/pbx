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
 */
import type { Db } from '@zamfono/shared';

import type { Channel } from './ari/types.js';
import type { LogLevel } from './callLog.js';
import type { Call } from './calls/call.js';
import {
  parseRtpAudioQos,
  qosFigures,
  RTP_AUDIO_QOS_VARIABLE,
  type QosFigures
} from './qosFigures.js';

// §7: `call_qos` is written at diagnostics level `qos` and `sip`, never at `none`/`events`.
const QOS_ELIGIBLE_LEVELS: ReadonlySet<LogLevel> = new Set(['qos', 'sip']);

type Role = 'caller' | 'callee';

type QosTarget = { channelId: string; role: Role };

// The caller's own channel, plus every leg bridged in (`up`) right now; a leg still ringing, or one
// that ended unanswered, never carried the call's own media.
function qosTargets(call: Call): QosTarget[] {
  const targets: QosTarget[] = [
    { channelId: call.callerChannelId, role: 'caller' }
  ];
  for (const leg of call.legs.values()) {
    if (leg.state === 'up') {
      targets.push({ channelId: leg.channelId, role: 'callee' });
    }
  }
  return targets;
}

/** One `call_qos` row. */
type QosRow = QosTarget & QosFigures & { callId: string };

/** One call's channels whose rows are still to come, those that have ended, the rows that came
 * before the call was written, and whether it was. */
type Tracked = {
  call: Call;
  roles: Map<string, Role>;
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
  private readonly calls = new Map<string, Tracked>();
  // Every tracked call a channel's row belongs to: a transfer makes one channel part of two.
  private readonly callsByChannel = new Map<string, Set<string>>();

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Notes `call`'s channels as they are now, each under its role: the caller's own and every leg
   * that is up. Safe to call any number of times for a call; a channel keeps the role it was last
   * noted with, and a leg noted once keeps its row when it leaves the call before it ends (a
   * transferrer, §10.1). Called whatever the level, since routing can still raise it (§7); the
   * level decides only at the write.
   */
  note(call: Call): void {
    const tracked = this.calls.get(call.id) ?? {
      call,
      roles: new Map<string, Role>(),
      ended: new Set<string>(),
      held: [],
      written: false
    };
    this.calls.set(call.id, tracked);
    for (const target of qosTargets(call)) {
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
   * A channel's `ChannelDestroyed`: its row, from the `RTPAUDIOQOS` the event carries, for every
   * call it was noted for, held for a call not written yet and written now for one that was. A
   * channel without an RTP instance (a Local channel) has no row. A leg whose instance saw no
   * packet still has one, of nothing measured: a bridged leg without media is a finding of its
   * own (no audio).
   */
  async channelEnded(channel: Channel): Promise<void> {
    const callIds = this.callsByChannel.get(channel.id);
    if (callIds === undefined) {
      return;
    }
    this.callsByChannel.delete(channel.id);
    const stat = parseRtpAudioQos(
      channel.channelvars?.[RTP_AUDIO_QOS_VARIABLE]
    );
    const now: QosRow[] = [];
    for (const callId of callIds) {
      const tracked = this.calls.get(callId);
      const role = tracked?.roles.get(channel.id);
      if (tracked === undefined || role === undefined) {
        continue;
      }
      tracked.roles.delete(channel.id);
      tracked.ended.add(channel.id);
      if (stat !== null) {
        const row = {
          callId,
          channelId: channel.id,
          role,
          ...qosFigures(stat)
        };
        if (!tracked.written) {
          tracked.held.push(row);
        } else if (eligible(tracked.call)) {
          now.push(row);
        }
      }
      this.forgetIfDone(tracked);
    }
    await this.insert(now);
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
    await this.insert(rows);
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
