/**
 * A call's `call_qos` rows (§7 level `qos`): each leg's RTCP summary, read through ARI before the
 * leg is hung up and held until `CdrWriter.finish` writes them. Its own module so `cdr.ts` stays
 * under the repository's `max-lines` lint rule.
 *
 * A leg's statistics die with its channel, and the party who hangs up takes theirs first: by the
 * time the core hears of a remote hangup, the channel may already answer 404. So every open call
 * is sampled while it runs, and each of its channels keeps its last reading: a leg that ends
 * without warning keeps the row read a few seconds before, and the reads at the call-ending
 * paths (`captureQos`) only freshen it.
 */
import type { Db } from '@zamfono/shared';

import type { AriClient } from './ari/client.js';
import type { LogLevel } from './callLog.js';
import type { Call } from './calls/call.js';
import { qosFigures, type QosFigures } from './qosFigures.js';

// §7: `call_qos` is written at diagnostics level `qos` and `sip`, never at `none`/`events`.
const QOS_ELIGIBLE_LEVELS: ReadonlySet<LogLevel> = new Set(['qos', 'sip']);

/** How often a call's legs are read while it runs. The packet counts and this side's jitter move
 * with every packet, the peer's figures with its RTCP reports (every 5 s by default); a short call
 * that ends by a hangup keeps only what the samples before it read, so they come well inside
 * that. One GET per leg, and only for a call at level `qos` or above. */
export const QOS_SAMPLE_MS = 2000;

type QosTarget = { channelId: string; role: 'caller' | 'callee' };

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

/** One `call_qos` row, held between the reads and `write`. */
type QosRow = QosTarget & QosFigures & { callId: string };

function eligible(call: Call): boolean {
  return QOS_ELIGIBLE_LEVELS.has(call.log.level);
}

/** The readings `CdrWriter` takes while a call's channels still exist, and their write. */
export class QosSnapshots {
  private readonly ari: AriClient;
  private readonly db: Db;
  private readonly sampleMs: number;
  private readonly snapshots = new Map<string, Map<string, QosRow>>();
  private readonly samplers = new Map<string, ReturnType<typeof setInterval>>();
  // A read still in flight when its call is written must not hold a row nobody writes.
  private readonly written = new Set<string>();

  constructor(ari: AriClient, db: Db, sampleMs: number = QOS_SAMPLE_MS) {
    this.ari = ari;
    this.db = db;
    this.sampleMs = sampleMs;
  }

  /**
   * Samples `call`'s channels every `sampleMs` until `write`, whatever answers them (a bridged
   * leg, a mailbox, a menu). The level is checked per sample, since routing can still raise it
   * (§7); a sample at a lower level reads nothing.
   */
  watch(call: Call): void {
    if (this.sampleMs <= 0 || this.samplers.has(call.id)) {
      return;
    }
    const timer = setInterval(() => {
      this.capture(call).catch(() => undefined);
    }, this.sampleMs);
    timer.unref();
    this.samplers.set(call.id, timer);
  }

  /**
   * Reads every live channel's RTP statistics and holds them until `write`. Safe to call any
   * number of times for a call: each channel keeps its latest reading, and one that has gone since
   * keeps the reading taken before it went, so a leg that left the call early (a transferrer,
   * §10.1) and the legs still in it at the end each count once, as of their own last reading (§7).
   */
  async capture(call: Call): Promise<void> {
    if (!eligible(call)) {
      return;
    }
    const rows = await this.read(call);
    if (!this.written.has(call.id)) {
      this.hold(call.id, rows);
    }
  }

  private hold(callId: string, rows: QosRow[]): Map<string, QosRow> {
    const held = this.snapshots.get(callId) ?? new Map<string, QosRow>();
    for (const row of rows) {
      held.set(row.channelId, row);
    }
    this.snapshots.set(callId, held);
    return held;
  }

  /** One reading per channel that answers; a channel that answers nothing, or fails, keeps what
   * it had, without costing the other channels theirs. A leg whose RTP instance saw no packet
   * still reads, as nothing measured: a bridged leg without media is a finding of its own (no
   * audio), and its counters only grow, so a later reading never replaces a better one. */
  private async read(call: Call): Promise<QosRow[]> {
    const targets = qosTargets(call);
    const stats = await Promise.allSettled(
      targets.map(target => this.ari.channels.rtpStatistics(target.channelId))
    );
    const rows: QosRow[] = [];
    targets.forEach((target, index) => {
      const result = stats[index];
      if (result?.status !== 'fulfilled' || result.value === null) {
        return;
      }
      rows.push({ callId: call.id, ...target, ...qosFigures(result.value) });
    });
    return rows;
  }

  /** Writes `call`'s held readings, updated by what its channels still answer now, as `call_qos`
   * rows, and stops sampling it. */
  async write(call: Call): Promise<void> {
    const sampler = this.samplers.get(call.id);
    if (sampler !== undefined) {
      clearInterval(sampler);
      this.samplers.delete(call.id);
    }
    if (!eligible(call)) {
      this.snapshots.delete(call.id);
      return;
    }
    const rows = [...this.hold(call.id, await this.read(call)).values()];
    this.written.add(call.id);
    this.snapshots.delete(call.id);
    if (rows.length === 0) {
      return;
    }
    await this.db.insertInto('callQos').values(rows).execute();
  }
}
