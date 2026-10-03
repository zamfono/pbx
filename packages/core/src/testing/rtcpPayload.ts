// Test-only: the RTCP report payloads res_hep_rtcp mirrors over HEP (§7 level `qos`), rendered
// the way Asterisk 22's `rtcp_report_to_json` (main/rtp_engine.c) and `ast_json_dump_string` do:
// compact JSON in the key order Asterisk packs, `lsr` and the NTP timestamps as strings, a
// receiver report's `sender_information` null.

import { MS_PER_SECOND } from '@zamfono/shared';

const RTCP_SR = 200;
const RTCP_RR = 201;
const NTP_UNIX_OFFSET_S = 2_208_988_800;
const FIXED_POINT_ONE = 65_536;
const UINT32_RANGE = 4_294_967_296;
const US_PER_SECOND = 1_000_000;
// A G.711 packet: 20 ms, 160 samples and bytes; and a block's fields the figures do not read.
const SAMPLES_PER_PACKET = 160;
const HIGHEST_SEQ_NO = 70_123;
const IA_JITTER = 17;

type BlockFields = {
  sourceSsrc: number;
  packetsLost?: number;
  lsr?: number;
  dlsr?: number;
};

/** The middle 32 bits of the NTP timestamp of `atMs`, as Asterisk puts it in a sender report
 * and a peer echoes it back as `lsr`. */
export function ntpMiddle(atMs: number): number {
  const seconds = Math.floor(atMs / MS_PER_SECOND);
  const usec = Math.round((atMs - seconds * MS_PER_SECOND) * MS_PER_SECOND);
  const lsw = Math.floor((usec * UINT32_RANGE) / US_PER_SECOND);
  const msw = seconds + NTP_UNIX_OFFSET_S;
  return (
    (msw % FIXED_POINT_ONE) * FIXED_POINT_ONE +
    Math.floor(lsw / FIXED_POINT_ONE)
  );
}

/** `seconds` in RTCP's 16.16 fixed point, as `dlsr` carries it. */
export function fixedPoint(seconds: number): number {
  return Math.round(seconds * FIXED_POINT_ONE);
}

function block(fields: BlockFields): Record<string, unknown> {
  return {
    source_ssrc: fields.sourceSsrc,
    fraction_lost: 0,
    packets_lost: fields.packetsLost ?? 0,
    highest_seq_no: HIGHEST_SEQ_NO,
    ia_jitter: IA_JITTER,
    lsr: String(fields.lsr ?? 0),
    dlsr: fields.dlsr ?? 0
  };
}

/** A sender or receiver report's payload: a sender report when `sent` (its packet count) is
 * given, sent at `atMs`. */
export function rtcpPayload(options: {
  ssrc: number;
  sent?: number;
  atMs?: number;
  blocks?: BlockFields[];
}): string {
  const blocks = (options.blocks ?? []).map(block);
  const atMs = options.atMs ?? 0;
  const seconds = Math.floor(atMs / MS_PER_SECOND);
  const senderInformation =
    options.sent === undefined
      ? null
      : {
          ntp_timestamp_sec: String(seconds),
          ntp_timestamp_usec: String(
            Math.round((atMs - seconds * MS_PER_SECOND) * MS_PER_SECOND)
          ),
          rtp_timestamp: SAMPLES_PER_PACKET * options.sent,
          packets: options.sent,
          octets: SAMPLES_PER_PACKET * options.sent
        };
  return JSON.stringify({
    ssrc: options.ssrc,
    type: options.sent === undefined ? RTCP_RR : RTCP_SR,
    report_count: blocks.length,
    sender_information: senderInformation,
    report_blocks: blocks
  });
}
