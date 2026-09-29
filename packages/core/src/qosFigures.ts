/**
 * One leg's `call_qos` figures (§7 level `qos`, §11 `call_qos`) from the ARI `RTPstat` Asterisk
 * answers for it. Asterisk reports jitter and round trip in seconds and loss as packet counts; the
 * row holds milliseconds and a percentage, one value per figure for both directions of the leg.
 */
import type { RtpStatistics } from './ari/types.js';

export type QosFigures = {
  jitterMs: number | null;
  lossPct: number | null;
  rttMs: number | null;
};

const MS_PER_SECOND = 1000;
const PERCENT = 100;
// Two decimals: finer than any jitter buffer or loss threshold anyone reads, and short in JSON.
const ROUNDING = 100;

function round(value: number): number {
  return Math.round(value * ROUNDING) / ROUNDING;
}

/** A field Asterisk sent as a finite, non-negative number, else 0 (absent, or a malformed reply). */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Whether `stat` saw any media at all: a leg that never sent or received a packet (a call
 * released before its media flowed) has nothing to summarise. */
export function carriedMedia(stat: RtpStatistics): boolean {
  return count(stat.rxcount) > 0 || count(stat.txcount) > 0;
}

/**
 * The worse direction's jitter: this side's own measurement of what it received (`txjitter`) or
 * the peer's of what it received, from its receiver report (`rxjitter`). Null when neither side
 * measured anything, since a jitter of 0 there means no packet was timed, not a perfect line.
 */
function jitterMs(stat: RtpStatistics): number | null {
  const own = count(stat.rxcount) > 0 ? count(stat.txjitter) : 0;
  const worst = Math.max(own, count(stat.rxjitter));
  if (worst === 0 && count(stat.rxcount) === 0) {
    return null;
  }
  return round(worst * MS_PER_SECOND);
}

/**
 * The worse direction's packet loss in percent: the packets this side missed against those it
 * expected (received plus missed), or those the peer reported missing against those sent. Null
 * when no packet went either way.
 */
function lossPct(stat: RtpStatistics): number | null {
  const shares: number[] = [];
  const rxLost = count(stat.rxploss);
  const rxExpected = count(stat.rxcount) + rxLost;
  if (rxExpected > 0) {
    shares.push(rxLost / rxExpected);
  }
  const sent = count(stat.txcount);
  if (sent > 0) {
    shares.push(Math.min(count(stat.txploss), sent) / sent);
  }
  return shares.length === 0 ? null : round(Math.max(...shares) * PERCENT);
}

/** The last round trip measured; null while no receiver report arrived, which Asterisk reports as
 * 0 (an unmeasured round trip is never 0 ms). */
function rttMs(stat: RtpStatistics): number | null {
  const rtt = count(stat.rtt);
  return rtt === 0 ? null : round(rtt * MS_PER_SECOND);
}

/** The `call_qos` figures of one `RTPstat` reading. */
export function qosFigures(stat: RtpStatistics): QosFigures {
  return {
    jitterMs: jitterMs(stat),
    lossPct: lossPct(stat),
    rttMs: rttMs(stat)
  };
}
