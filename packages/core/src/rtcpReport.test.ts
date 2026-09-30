import { describe, expect, it } from 'vitest';

import { parseRtcpReport } from './rtcpReport.js';
import { rtcpPayload } from './testing/rtcpPayload.js';

describe('parseRtcpReport (§7 level qos)', () => {
  it('reads a sender report exactly as Asterisk 22 renders it', () => {
    // A sender report Asterisk sent, byte for byte as `rtcp_report_to_json` and
    // `ast_json_dump_string` produce it.
    const payload =
      '{"ssrc":3581287122,"type":200,"report_count":1,"sender_information":' +
      '{"ntp_timestamp_sec":"1790000000","ntp_timestamp_usec":"250000",' +
      '"rtp_timestamp":160000,"packets":1000,"octets":160000},"report_blocks":' +
      '[{"source_ssrc":1203774560,"fraction_lost":2,"packets_lost":7,' +
      '"highest_seq_no":70123,"ia_jitter":17,"lsr":"3183606784","dlsr":32768}]}';

    expect(parseRtcpReport(payload)).toEqual({
      ssrc: 3_581_287_122,
      sentPackets: 1000,
      blocks: [
        {
          sourceSsrc: 1_203_774_560,
          packetsLost: 7,
          lsr: 3_183_606_784,
          dlsr: 32_768
        }
      ]
    });
  });

  it('reads a receiver report, whose sender information is null, and one without blocks', () => {
    expect(
      parseRtcpReport(
        rtcpPayload({ ssrc: 1, blocks: [{ sourceSsrc: 2, packetsLost: 4 }] })
      )
    ).toEqual({
      ssrc: 1,
      sentPackets: null,
      blocks: [{ sourceSsrc: 2, packetsLost: 4, lsr: 0, dlsr: 0 }]
    });
    expect(parseRtcpReport(rtcpPayload({ ssrc: 1 }))).toEqual({
      ssrc: 1,
      sentPackets: null,
      blocks: []
    });
  });

  it('reads a negative cumulative loss, which Asterisk passes on as its low 24 bits, as none', () => {
    // -1: one duplicate more than packets lost.
    const report = parseRtcpReport(
      rtcpPayload({
        ssrc: 1,
        blocks: [{ sourceSsrc: 2, packetsLost: 0xffffff }]
      })
    );

    expect(report?.blocks[0]?.packetsLost).toBe(0);
  });

  it('skips a malformed block and rejects what is no sender or receiver report', () => {
    expect(
      parseRtcpReport(
        '{"ssrc":1,"type":201,"report_count":2,"sender_information":null,' +
          '"report_blocks":[{"source_ssrc":2},{"source_ssrc":3,"fraction_lost":0,' +
          '"packets_lost":1,"highest_seq_no":9,"ia_jitter":0,"lsr":"0","dlsr":0}]}'
      )?.blocks
    ).toEqual([{ sourceSsrc: 3, packetsLost: 1, lsr: 0, dlsr: 0 }]);
    expect(parseRtcpReport('INVITE sip:101@10.0.0.1 SIP/2.0')).toBeNull();
    expect(parseRtcpReport('[]')).toBeNull();
    expect(parseRtcpReport('{"ssrc":1,"type":203}')).toBeNull();
    expect(parseRtcpReport('{"type":200}')).toBeNull();
  });
});
