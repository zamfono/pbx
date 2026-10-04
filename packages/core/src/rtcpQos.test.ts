import { describe, expect, it } from 'vitest';

import { RtcpQos, withRtcp } from './rtcpQos.js';
import { parseRtcpReport, type RtcpHepReport } from './rtcpReport.js';
import { fixedPoint, ntpMiddle, rtcpPayload } from './testing/rtcpPayload.js';

const CALL_ID = 'a84b4c76e66710@198.51.100.20';
const ASTERISK_SSRC = 3_581_287_122;
const PHONE_SSRC = 1_203_774_560;
// 2026-09-21 14:13:20 UTC, on Asterisk's clock.
const T0 = 1_790_000_000_000;

/** One mirrored report, from the payload Asterisk would send. */
function mirrored(
  sender: RtcpHepReport['sender'],
  atMs: number,
  payload: string
): RtcpHepReport {
  const report = parseRtcpReport(payload);
  if (report === null) {
    throw new Error('not a report');
  }
  return { callId: CALL_ID, atMs, sender, report };
}

describe('RtcpQos (§7 level qos)', () => {
  it('measures the round trip from a peer report answering Asterisk’s sender report', () => {
    const rtcp = new RtcpQos();
    rtcp.join('leg', CALL_ID);
    // Asterisk's sender report at T0; the phone holds it 250 ms and answers, and its report
    // arrives 330 ms after T0: 80 ms on the wire, both ways together.
    rtcp.report(
      mirrored(
        'asterisk',
        T0,
        rtcpPayload({ ssrc: ASTERISK_SSRC, sent: 250, atMs: T0 })
      )
    );
    rtcp.report(
      mirrored(
        'peer',
        T0 + 330,
        rtcpPayload({
          ssrc: PHONE_SSRC,
          blocks: [
            {
              sourceSsrc: ASTERISK_SSRC,
              lsr: ntpMiddle(T0),
              dlsr: fixedPoint(0.25)
            }
          ]
        })
      )
    );

    const figures = rtcp.take('leg');

    expect(figures?.jitterMs).toBeNull();
    expect(figures?.lossPct).toBe(0);
    expect(figures?.rttMs).toBeCloseTo(80, 1);
  });

  it('keeps the last round trip, not one of a report answering none or skewed', () => {
    const rtcp = new RtcpQos();
    rtcp.join('leg', CALL_ID);
    const answering = (atMs: number, sentAt: number, held: number): string =>
      rtcpPayload({
        ssrc: PHONE_SSRC,
        blocks: [
          {
            sourceSsrc: ASTERISK_SSRC,
            lsr: ntpMiddle(sentAt),
            dlsr: fixedPoint(held)
          }
        ]
      });
    rtcp.report(mirrored('peer', T0 + 120, answering(T0 + 120, T0, 0.1)));
    // No sender report answered yet, and a delay longer than the time since the report.
    rtcp.report(
      mirrored(
        'peer',
        T0 + 5000,
        rtcpPayload({
          ssrc: PHONE_SSRC,
          blocks: [{ sourceSsrc: ASTERISK_SSRC }]
        })
      )
    );
    rtcp.report(
      mirrored('peer', T0 + 5100, answering(T0 + 5100, T0 + 5000, 2))
    );

    expect(rtcp.take('leg')?.rttMs).toBeCloseTo(20, 1);
  });

  it('takes the worse direction’s loss against the other side’s sent count', () => {
    const rtcp = new RtcpQos();
    rtcp.join('leg', CALL_ID);
    // Asterisk sent 1000 packets and the phone missed 20 of them (2 %); the phone sent 500 and
    // Asterisk missed 5 (1 %).
    rtcp.report(
      mirrored(
        'asterisk',
        T0,
        rtcpPayload({
          ssrc: ASTERISK_SSRC,
          sent: 1000,
          blocks: [{ sourceSsrc: PHONE_SSRC, packetsLost: 5 }]
        })
      )
    );
    rtcp.report(
      mirrored(
        'peer',
        T0 + 100,
        rtcpPayload({
          ssrc: PHONE_SSRC,
          sent: 500,
          blocks: [
            { sourceSsrc: 999, packetsLost: 400 },
            { sourceSsrc: ASTERISK_SSRC, packetsLost: 20 }
          ]
        })
      )
    );

    expect(rtcp.take('leg')).toEqual({
      jitterMs: null,
      lossPct: 2,
      rttMs: null,
      rxPackets: null,
      txPackets: 1000
    });
  });

  it('measures only the packets sent of Asterisk’s own reports alone, a peer that sends no RTCP', () => {
    const rtcp = new RtcpQos();
    rtcp.join('leg', CALL_ID);
    rtcp.report(
      mirrored(
        'asterisk',
        T0,
        rtcpPayload({
          ssrc: ASTERISK_SSRC,
          sent: 300,
          blocks: [{ sourceSsrc: PHONE_SSRC, packetsLost: 2 }]
        })
      )
    );

    expect(rtcp.take('leg')).toEqual({
      jitterMs: null,
      lossPct: null,
      rttMs: null,
      rxPackets: null,
      txPackets: 300
    });
  });

  it('counts no packets received from the peer’s sender report, which counts what it sent', () => {
    const rtcp = new RtcpQos();
    rtcp.join('leg', CALL_ID);
    // The phone reports 500 packets sent, which need not have reached Asterisk (NAT, a blocked
    // RTP port); and Asterisk, having sent nothing, sends receiver reports only.
    rtcp.report(
      mirrored('peer', T0, rtcpPayload({ ssrc: PHONE_SSRC, sent: 500 }))
    );
    rtcp.report(mirrored('asterisk', T0, rtcpPayload({ ssrc: ASTERISK_SSRC })));

    expect(rtcp.take('leg')).toMatchObject({
      rxPackets: null,
      txPackets: null
    });
  });

  it('gives a leg’s figures up once, and none for a channel never joined or without reports', () => {
    const rtcp = new RtcpQos();
    rtcp.report(
      mirrored('asterisk', T0, rtcpPayload({ ssrc: ASTERISK_SSRC, sent: 1 }))
    );
    rtcp.join('quiet', 'other-call-id');

    expect(rtcp.take('unjoined')).toBeNull();
    expect(rtcp.take('quiet')).toBeNull();
    rtcp.join('leg', CALL_ID);
    expect(rtcp.take('leg')).not.toBeNull();
    expect(rtcp.take('leg')).toBeNull();
  });

  it('drops a leg whose reports stopped long ago, and the joins of channels gone', () => {
    let now = 0;
    const rtcp = new RtcpQos(() => now);
    rtcp.join('old', 'old-call-id');
    rtcp.join('live', CALL_ID);
    rtcp.report({
      ...mirrored('asterisk', T0, rtcpPayload({ ssrc: 1, sent: 1 })),
      callId: 'old-call-id'
    });
    now = 6 * 60_000;
    rtcp.report(mirrored('asterisk', T0, rtcpPayload({ ssrc: 2, sent: 1 })));

    expect(rtcp.take('old')).toBeNull();

    rtcp.join('gone', 'gone-call-id');
    rtcp.release(rtcp.joined(), new Set(['live']));
    expect(rtcp.joined()).toEqual(['live']);
  });
});

describe('withRtcp', () => {
  it('keeps every figure the summary measured and fills the ones it left null', () => {
    const unmeasured = { rxPackets: null, txPackets: null };
    expect(
      withRtcp(
        { jitterMs: 3.4, lossPct: null, rttMs: null, ...unmeasured },
        {
          jitterMs: null,
          lossPct: 0,
          rttMs: 81.2,
          rxPackets: null,
          txPackets: 900
        }
      )
    ).toEqual({
      jitterMs: 3.4,
      lossPct: 0,
      rttMs: 81.2,
      rxPackets: null,
      txPackets: 900
    });
    // A count of 0 is a measurement and wins as any other.
    expect(
      withRtcp(
        { jitterMs: 3.4, lossPct: 1, rttMs: 42, rxPackets: 0, txPackets: 0 },
        {
          jitterMs: null,
          lossPct: 2,
          rttMs: 81.2,
          ...unmeasured,
          txPackets: 900
        }
      )
    ).toEqual({
      jitterMs: 3.4,
      lossPct: 1,
      rttMs: 42,
      rxPackets: 0,
      txPackets: 0
    });
  });

  it('takes either alone, and gives no figures when neither is there', () => {
    const figures = {
      jitterMs: null,
      lossPct: 0,
      rttMs: 12,
      rxPackets: null,
      txPackets: 40
    };

    expect(withRtcp(null, figures)).toEqual(figures);
    expect(withRtcp(figures, null)).toEqual(figures);
    expect(withRtcp(null, null)).toBeNull();
  });
});
