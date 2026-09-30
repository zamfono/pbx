/**
 * §7 level `qos`: a leg's `call_qos` figures from the RTCP reports Asterisk mirrors over HEP
 * (`rtcpReport.ts`), for what the `RTPAUDIOQOS` summary at hangup leaves unmeasured, or for a leg
 * whose summary never arrived. A report carries the channel's Call-ID, as SIP messages do; each
 * channel's Call-ID is joined to it as its dialog is joined to its call (`SipCapture.register`),
 * so a leg's reports are found by its channel when it ends.
 *
 * Per Call-ID only the latest of each kind is kept: Asterisk's own last report block and sent
 * count, the peer's, and the last round trip the peer's reports gave, whatever the call's level,
 * which is decided at the write, as for the summary.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import { roundFigure, type QosFigures } from './qosFigures.js';
import type { RtcpHepReport, RtcpReportBlock } from './rtcpReport.js';

/** What one channel's RTCP reports measured so far. */
type RtcpLeg = {
  /** When the core last received a report for it, for `STALE_MS`. */
  seenAt: number;
  /** Asterisk's SSRC on this leg, from its own reports. */
  ssrc: number | null;
  /** Packets sent, from each side's latest sender report. */
  sent: number | null;
  peerSent: number | null;
  /** Packets missed, from each side's latest report block: Asterisk's of the peer's stream, the
   * peer's of Asterisk's. */
  lost: number | null;
  peerLost: number | null;
  /** The last round trip, in seconds, from a peer report block answering one of Asterisk's
   * sender reports. */
  rtt: number | null;
};

// A leg whose reports stopped this long ago without its channel ending (a `ChannelDestroyed`
// lost with the ARI connection, a channel of no call) is dropped: a leg with media reports every
// few seconds, even on hold. Five minutes.
const STALE_MS = 300_000;
const PERCENT = 100;
// NTP counts seconds from 1900, the Unix clock from 1970.
const NTP_UNIX_OFFSET_S = 2_208_988_800;
// RTCP's round-trip fields are 16.16 fixed-point seconds.
const FIXED_POINT_ONE = 65_536;
const UINT32_RANGE = 4_294_967_296;

/** The middle 32 bits of the NTP timestamp of `atMs` (RFC 3550 §6.4.1), what `lsr` echoes. */
function ntpMiddle(atMs: number): number {
  const seconds = Math.floor(atMs / MS_PER_SECOND);
  const fraction =
    ((atMs - seconds * MS_PER_SECOND) / MS_PER_SECOND) * UINT32_RANGE;
  const ntpSeconds = (seconds + NTP_UNIX_OFFSET_S) % FIXED_POINT_ONE;
  return ntpSeconds * FIXED_POINT_ONE + Math.floor(fraction / FIXED_POINT_ONE);
}

/**
 * The round trip in seconds a peer report block captured at `atMs` gives: its arrival less the
 * time Asterisk sent the sender report it answers (`lsr`) and the time the peer held it (`dlsr`),
 * as `update_rtt_stats` (res_rtp_asterisk.c) computes it; null for a block answering none, or one
 * whose delay exceeds the time since that report, which a skewed peer clock gives.
 */
function roundTrip(block: RtcpReportBlock, atMs: number): number | null {
  if (block.lsr === 0) {
    return null;
  }
  const answered = (ntpMiddle(atMs) - block.dlsr + UINT32_RANGE) % UINT32_RANGE;
  if (answered < block.lsr) {
    return null;
  }
  return (answered - block.lsr) / FIXED_POINT_ONE;
}

/** The share of `sent` packets reported `lost`, once both are known and anything was sent. */
function lossShare(lost: number | null, sent: number | null): number | null {
  return lost === null || sent === null || sent === 0
    ? null
    : Math.min(lost, sent) / sent;
}

/**
 * The figures of one leg's reports: the worse direction's loss, the packets one side reported
 * missed against those the other side's latest sender report counted as sent, and the last round
 * trip. Jitter is not among them: a report block gives it in RTP timestamp units, whose clock rate
 * (the codec's) the report does not carry. The packets sent are those of Asterisk's latest sender
 * report, the same count `RTPAUDIOQOS`'s `txcount` gives, as of that report. The packets received
 * are not: the peer's sender report counts what the peer sent, not what reached Asterisk, and
 * taking it would hide exactly the leg whose audio never arrived (§7 level `qos`).
 */
function figures(leg: RtcpLeg): QosFigures {
  const shares = [
    lossShare(leg.lost, leg.peerSent),
    lossShare(leg.peerLost, leg.sent)
  ].filter((share): share is number => share !== null);
  return {
    jitterMs: null,
    lossPct:
      shares.length === 0 ? null : roundFigure(Math.max(...shares) * PERCENT),
    rttMs:
      leg.rtt === null || leg.rtt <= 0
        ? null
        : roundFigure(leg.rtt * MS_PER_SECOND),
    rxPackets: null,
    txPackets: leg.sent
  };
}

/** A figure `RTPAUDIOQOS` measured wins; one it left null is taken from the RTCP reports. */
export function withRtcp(
  summary: QosFigures | null,
  rtcp: QosFigures | null
): QosFigures | null {
  if (summary === null || rtcp === null) {
    return summary ?? rtcp;
  }
  return {
    jitterMs: summary.jitterMs ?? rtcp.jitterMs,
    lossPct: summary.lossPct ?? rtcp.lossPct,
    rttMs: summary.rttMs ?? rtcp.rttMs,
    rxPackets: summary.rxPackets ?? rtcp.rxPackets,
    txPackets: summary.txPackets ?? rtcp.txPackets
  };
}

export class RtcpQos {
  private readonly now: () => number;
  private readonly legs = new Map<string, RtcpLeg>();
  private readonly sipCallIds = new Map<string, string>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** How many legs' reports are kept; a test seam. */
  get size(): number {
    return this.legs.size;
  }

  /** Joins `channelId` to its SIP Call-ID, under which its reports arrive. */
  join(channelId: string, sipCallId: string): void {
    this.sipCallIds.set(channelId, sipCallId);
  }

  /** Takes one mirrored report into its leg's figures. */
  report({ callId, atMs, sender, report }: RtcpHepReport): void {
    const leg = this.legs.get(callId) ?? this.newLeg(callId);
    leg.seenAt = this.now();
    if (sender === 'asterisk') {
      leg.ssrc = report.ssrc;
      leg.sent = report.sentPackets ?? leg.sent;
      leg.lost = report.blocks[0]?.packetsLost ?? leg.lost;
      return;
    }
    leg.peerSent = report.sentPackets ?? leg.peerSent;
    // The peer's block of Asterisk's own stream, where the peer reports on several.
    const block =
      report.blocks.find(({ sourceSsrc }) => sourceSsrc === leg.ssrc) ??
      report.blocks[0];
    if (block !== undefined) {
      leg.peerLost = block.packetsLost;
      leg.rtt = roundTrip(block, atMs) ?? leg.rtt;
    }
  }

  /** The figures of `channelId`'s reports, which it gives up as its channel ends; null when none
   * arrived. */
  take(channelId: string): QosFigures | null {
    const sipCallId = this.sipCallIds.get(channelId);
    this.sipCallIds.delete(channelId);
    const leg = sipCallId === undefined ? undefined : this.legs.get(sipCallId);
    if (sipCallId === undefined || leg === undefined) {
      return null;
    }
    this.legs.delete(sipCallId);
    return figures(leg);
  }

  /** The channels joined now, for a later `release`. */
  joined(): string[] {
    return [...this.sipCallIds.keys()];
  }

  /** Lets go of the joins of `channelIds` Asterisk no longer holds, whose end was never seen. */
  release(
    channelIds: readonly string[],
    liveChannelIds: ReadonlySet<string>
  ): void {
    for (const channelId of channelIds) {
      if (!liveChannelIds.has(channelId)) {
        this.sipCallIds.delete(channelId);
      }
    }
  }

  private newLeg(sipCallId: string): RtcpLeg {
    const cutoff = this.now() - STALE_MS;
    for (const [id, leg] of this.legs) {
      if (leg.seenAt < cutoff) {
        this.legs.delete(id);
      }
    }
    const leg: RtcpLeg = {
      seenAt: 0,
      ssrc: null,
      sent: null,
      peerSent: null,
      lost: null,
      peerLost: null,
      rtt: null
    };
    this.legs.set(sipCallId, leg);
    return leg;
  }
}
