/**
 * §7: which of the HEP collector's datagrams reach the `sip` call log and which the `qos` figures.
 * Asterisk mirrors both SIP messages (`res_hep_pjsip`) and RTCP reports (`res_hep_rtcp`) to the
 * same listener, under the same correlation id, the channel's Call-ID; only the protocol type
 * tells them apart. Its own module so `hep.ts` stays under the repository's `max-lines` lint rule.
 */
import type { ParsedHep } from './hep.js';
import { parseRtcpReport, type RtcpHepReport } from './rtcpReport.js';
import type { SipMessage } from './sipCapture.js';

// The payload types res_hep labels a datagram with (`HEPV3_CAPTURE_TYPE_*`, res_hep.h): a SIP
// message from res_hep_pjsip, an RTCP report from res_hep_rtcp.
const PROTOCOL_SIP = 1;
const PROTOCOL_RTCP = 5;
// A SIP message's start line: a request's (`INVITE sip:… SIP/2.0`) or a response's
// (`SIP/2.0 200 OK`).
const SIP_START_LINE =
  /^(?:[A-Z]+ \S+ SIP\/2\.0(?:\r?\n|$)|SIP\/2\.0 \d{3}\b)/u;

/** Where a parsed datagram goes: a SIP message to the call log, an RTCP report to QoS (§7). */
export type HepHandlers = {
  sip(message: SipMessage): void;
  rtcp(report: RtcpHepReport): void;
};

/** Whose report an RTCP datagram carries, by its addresses; null when neither is Asterisk's. */
function rtcpSender(parsed: ParsedHep): RtcpHepReport['sender'] | null {
  if (parsed.direction === 'out') {
    return 'asterisk';
  }
  return parsed.toAsterisk ? 'peer' : null;
}

/**
 * Hands a datagram to its handler by its protocol type. Only a SIP message (type 1) reaches the
 * SIP log; a datagram without a type, which res_hep never sends, does too when its payload opens
 * with a SIP start line, and a datagram of any other type is dropped, so no RTCP report or other
 * payload is ever logged as a SIP message. An RTCP report is Asterisk's own when its source is
 * one of Asterisk's addresses and the peer's when its destination is; one that is neither is
 * dropped, since its report blocks could not be told apart.
 */
export function dispatchHep(parsed: ParsedHep, handlers: HepHandlers): void {
  const { callId, at, direction, payload } = parsed;
  if (parsed.protocol === PROTOCOL_RTCP) {
    const report = parseRtcpReport(payload);
    const sender = rtcpSender(parsed);
    if (report !== null && sender !== null) {
      handlers.rtcp({ callId, atMs: parsed.atMs, sender, report });
    }
    return;
  }
  if (
    parsed.protocol === PROTOCOL_SIP ||
    (parsed.protocol === null && SIP_START_LINE.test(payload.trimStart()))
  ) {
    handlers.sip({ callId, at, direction, payload });
  }
}
