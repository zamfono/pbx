/**
 * The RTCP reports Asterisk mirrors over HEP (§7 level `qos`). res_hep_rtcp sends one datagram per
 * sender or receiver report an RTP instance sends or receives, its payload the report as
 * `rtcp_report_to_json` (main/rtp_engine.c) renders it:
 *
 *   {"ssrc":…,"type":200,"report_count":1,
 *    "sender_information":{"ntp_timestamp_sec":"…","ntp_timestamp_usec":"…","rtp_timestamp":…,
 *                          "packets":…,"octets":…},
 *    "report_blocks":[{"source_ssrc":…,"fraction_lost":…,"packets_lost":…,"highest_seq_no":…,
 *                      "ia_jitter":…,"lsr":"…","dlsr":…}]}
 *
 * `type` is 200 for a sender report, whose `sender_information` is set, and 201 for a receiver
 * report, whose is null; `lsr` alone is a string.
 */

/** One report block: what the report's sender measured of the stream `sourceSsrc` sent. */
export type RtcpReportBlock = {
  sourceSsrc: number;
  /** Cumulative packets lost of that stream. */
  packetsLost: number;
  /** The middle 32 bits of the NTP timestamp of the last sender report received from that
   * stream's sender, 0 while none arrived. */
  lsr: number;
  /** The delay between receiving that sender report and sending this one, in 1/65536 s. */
  dlsr: number;
};

export type RtcpReport = {
  ssrc: number;
  /** The packets its sender has sent, from a sender report; null for a receiver report. */
  sentPackets: number | null;
  blocks: RtcpReportBlock[];
};

/** One mirrored report: Asterisk's own (`asterisk`, one it sent) or the peer's (one it received),
 * with the time Asterisk captured it, in milliseconds since the epoch on Asterisk's clock. */
export type RtcpHepReport = {
  callId: string;
  atMs: number;
  sender: 'asterisk' | 'peer';
  report: RtcpReport;
};

const RTCP_SR = 200;
const RTCP_RR = 201;
// `packets_lost` is RTCP's signed 24-bit field, which Asterisk passes on masked to its low 24 bits
// (res_rtp_asterisk.c): a value with the sign bit set is a negative count, more duplicates than
// losses, and so no loss.
const PACKETS_LOST_SIGN_BIT = 0x800000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field as a non-negative integer, from a number or a numeric string; null otherwise. */
function integer(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 0
    ? number
    : null;
}

function reportBlock(value: unknown): RtcpReportBlock | null {
  if (!isRecord(value)) {
    return null;
  }
  const sourceSsrc = integer(value.source_ssrc);
  const packetsLost = integer(value.packets_lost);
  const lsr = integer(value.lsr);
  const dlsr = integer(value.dlsr);
  if (
    sourceSsrc === null ||
    packetsLost === null ||
    lsr === null ||
    dlsr === null
  ) {
    return null;
  }
  return {
    sourceSsrc,
    packetsLost: packetsLost >= PACKETS_LOST_SIGN_BIT ? 0 : packetsLost,
    lsr,
    dlsr
  };
}

/** `payload` parsed as JSON; null for one that is not. */
function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/** The report a datagram's payload carries; null for one that is not a well-formed sender or
 * receiver report. A malformed report block is skipped, the rest of the report kept. */
export function parseRtcpReport(payload: string): RtcpReport | null {
  const json = parseJson(payload);
  if (!isRecord(json)) {
    return null;
  }
  const ssrc = integer(json.ssrc);
  const type = integer(json.type);
  if (ssrc === null || (type !== RTCP_SR && type !== RTCP_RR)) {
    return null;
  }
  const info = json.sender_information;
  const sentPackets =
    type === RTCP_SR && isRecord(info) ? integer(info.packets) : null;
  const blocks = Array.isArray(json.report_blocks)
    ? json.report_blocks
        .map(reportBlock)
        .filter((block): block is RtcpReportBlock => block !== null)
    : [];
  return { ssrc, sentPackets, blocks };
}
