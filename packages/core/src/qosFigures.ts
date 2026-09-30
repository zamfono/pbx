/**
 * One leg's `call_qos` figures (§7 level `qos`, §11 `call_qos`) from the `RTPAUDIOQOS` variable
 * Asterisk sets on the leg's channel as it hangs up. Asterisk reports jitter and round trip in
 * seconds and loss as packet counts; the row holds milliseconds and a percentage, one value per
 * figure for both directions of the leg.
 */

/** The variable, as `ast_rtp_instance_get_quality` (main/rtp_engine.c) writes it for a channel
 * with an RTP instance: `ssrc=%u;themssrc=%u;lp=%u;rxjitter=%f;rxcount=%u;txjitter=%f;txcount=%u;
 * rlp=%u;rtt=%f;rxmes=%f;txmes=%f`, the same `ast_rtp_instance_stats` fields ARI's `RTPstat`
 * carries. Unset, a channel without one (a Local channel) reports it as "". */
export const RTP_AUDIO_QOS_VARIABLE = 'RTPAUDIOQOS';

/**
 * The fields of `RTPAUDIOQOS` the summary reads, under `RTPstat`'s names for them: `rxploss` is
 * the variable's `lp`, the packets this side missed as of its last RTCP report, and `txploss` its
 * `rlp`, those the peer reported missing. `txjitter` is this side's own interarrival jitter of the
 * packets it received, `rxjitter` the peer's of the packets it received, from its RTCP receiver
 * report; `rtt` the last round trip measured from a receiver report, 0 while none arrived.
 */
export type RtpQos = {
  txcount: number;
  rxcount: number;
  txjitter: number;
  rxjitter: number;
  txploss: number;
  rxploss: number;
  rtt: number;
};

const FIELD_NAMES: Readonly<Record<string, keyof RtpQos>> = {
  txcount: 'txcount',
  rxcount: 'rxcount',
  txjitter: 'txjitter',
  rxjitter: 'rxjitter',
  lp: 'rxploss',
  rlp: 'txploss',
  rtt: 'rtt'
};

/** The figures of an `RTPAUDIOQOS` value, `null` for an unset one or one that names none of them
 * (a channel without an RTP instance). A field absent or malformed reads as 0. */
export function parseRtpAudioQos(value: string | undefined): RtpQos | null {
  const stat: RtpQos = {
    txcount: 0,
    rxcount: 0,
    txjitter: 0,
    rxjitter: 0,
    txploss: 0,
    rxploss: 0,
    rtt: 0
  };
  let known = 0;
  for (const pair of (value ?? '').split(';')) {
    const [name = '', raw = ''] = pair.split('=');
    const field = FIELD_NAMES[name.trim()];
    const number = Number(raw);
    if (field !== undefined && raw.trim() !== '' && Number.isFinite(number)) {
      stat[field] = number;
      known += 1;
    }
  }
  return known === 0 ? null : stat;
}

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

/** A finite, non-negative figure, else 0. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The worse direction's jitter: this side's own measurement of what it received (`txjitter`) or
 * the peer's of what it received, from its receiver report (`rxjitter`). Null when neither side
 * measured anything, since a jitter of 0 there means no packet was timed, not a perfect line.
 */
function jitterMs(stat: RtpQos): number | null {
  const own = count(stat.rxcount) > 0 ? count(stat.txjitter) : 0;
  const worst = Math.max(own, count(stat.rxjitter));
  if (worst === 0 && count(stat.rxcount) === 0) {
    return null;
  }
  return round(worst * MS_PER_SECOND);
}

/**
 * The worse direction's packet loss in percent: the packets this side missed (`lp`) against those
 * it expected (received plus missed), once it received any, or those the peer reported missing
 * (`rlp`) against those sent, once it sent any. Null when no packet went either way. A side that
 * received nothing measured no loss: Asterisk then reports one packet missed out of none.
 */
function lossPct(stat: RtpQos): number | null {
  const shares: number[] = [];
  const received = count(stat.rxcount);
  if (received > 0) {
    const rxLost = count(stat.rxploss);
    shares.push(rxLost / (received + rxLost));
  }
  const sent = count(stat.txcount);
  if (sent > 0) {
    shares.push(Math.min(count(stat.txploss), sent) / sent);
  }
  return shares.length === 0 ? null : round(Math.max(...shares) * PERCENT);
}

/** The last round trip measured; null while no receiver report arrived, which Asterisk reports as
 * 0 (an unmeasured round trip is never 0 ms). */
function rttMs(stat: RtpQos): number | null {
  const rtt = count(stat.rtt);
  return rtt === 0 ? null : round(rtt * MS_PER_SECOND);
}

/** The `call_qos` figures of one leg's statistics. */
export function qosFigures(stat: RtpQos): QosFigures {
  return {
    jitterMs: jitterMs(stat),
    lossPct: lossPct(stat),
    rttMs: rttMs(stat)
  };
}
