/**
 * A call's `call_qos` rows (§7 level `qos`): each leg's RTCP summary, read through ARI before the
 * leg is hung up and held until `CdrWriter.finish` writes them. Its own module so `cdr.ts` stays
 * under the repository's `max-lines` lint rule.
 */
import type { Db } from '@zamfono/shared';

import type { AriClient } from './ari/client.js';
import type { RtpStatistics } from './ari/types.js';
import type { LogLevel } from './callLog.js';
import type { Call } from './calls/call.js';

// §7: `call_qos` is written at diagnostics level `qos` and `sip`, never at `none`/`events`.
const QOS_ELIGIBLE_LEVELS: ReadonlySet<LogLevel> = new Set(['qos', 'sip']);

type QosTarget = { channelId: string; role: 'caller' | 'callee' };

// The caller's own channel, plus every leg still bridged (`up`) when the call ends; a leg that
// already ended (declined, or superseded by the winner) never carried the call's own media.
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

/** One `call_qos` row, held between `capture` and `write`. */
type QosRow = {
  callId: string;
  channelId: string;
  role: 'caller' | 'callee';
  jitterMs: number;
  lossPct: number;
  rttMs: number;
};

/** The snapshots `CdrWriter` takes while a call's channels still exist, and their write. */
export class QosSnapshots {
  private readonly ari: AriClient;
  private readonly db: Db;
  private readonly snapshots = new Map<string, Map<string, QosRow>>();

  constructor(ari: AriClient, db: Db) {
    this.ari = ari;
    this.db = db;
  }

  /**
   * Reads every live channel's RTP statistics and holds them until `write`. Safe to call more
   * than once for a call: each channel keeps its latest reading, and one that has gone since keeps
   * the reading taken before it went, so a leg that left the call early (a transferrer, §10.1)
   * and the legs still in it at the end each count once, as of their own hangup (§7).
   */
  async capture(call: Call): Promise<void> {
    if (!QOS_ELIGIBLE_LEVELS.has(call.log.level)) {
      return;
    }
    this.hold(call.id, await this.read(call));
  }

  private hold(callId: string, rows: QosRow[]): Map<string, QosRow> {
    const held = this.snapshots.get(callId) ?? new Map<string, QosRow>();
    for (const row of rows) {
      held.set(row.channelId, row);
    }
    this.snapshots.set(callId, held);
    return held;
  }

  private async read(call: Call): Promise<QosRow[]> {
    const targets = qosTargets(call);
    const stats = await Promise.all(
      targets.map(target => this.ari.channels.rtpStatistics(target.channelId))
    );
    return targets
      .map((target, index) => ({ target, stat: stats[index] }))
      .filter(
        (entry): entry is { target: QosTarget; stat: RtpStatistics } =>
          entry.stat !== null
      )
      .map(({ target, stat }) => ({
        callId: call.id,
        channelId: target.channelId,
        role: target.role,
        jitterMs: stat.jitter,
        lossPct: stat.loss,
        rttMs: stat.rtt
      }));
  }

  /** Writes `call`'s held readings, updated by what its channels still answer now, as `call_qos`
   * rows. */
  async write(call: Call): Promise<void> {
    if (!QOS_ELIGIBLE_LEVELS.has(call.log.level)) {
      return;
    }
    const rows = [...this.hold(call.id, await this.read(call)).values()];
    this.snapshots.delete(call.id);
    if (rows.length === 0) {
      return;
    }
    await this.db.insertInto('callQos').values(rows).execute();
  }
}
