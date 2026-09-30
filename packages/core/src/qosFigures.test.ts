import { describe, expect, it } from 'vitest';

import { fakeRtpAudioQos } from './ari/fakeRtp.js';
import { parseRtpAudioQos, qosFigures } from './qosFigures.js';

describe('parseRtpAudioQos (§7 level qos)', () => {
  it('reads a packet count of 0 as 0 and an absent or malformed one as null', () => {
    expect(
      parseRtpAudioQos('lp=1;rxjitter=0;rxcount=0;txjitter=0;txcount=0;rlp=0')
    ).toMatchObject({ rxcount: 0, txcount: 0 });
    expect(
      parseRtpAudioQos('lp=0;rxjitter=0.001;rxcount=;txcount=many;rtt=0.02')
    ).toMatchObject({ rxcount: null, txcount: null, rtt: 0.02 });
  });

  it('reads no figures of an unset variable or one that names none', () => {
    expect(parseRtpAudioQos(undefined)).toBeNull();
    expect(parseRtpAudioQos('')).toBeNull();
    expect(parseRtpAudioQos('ssrc=1;themssrc=2')).toBeNull();
  });
});

describe('qosFigures', () => {
  it('counts the packets received and sent next to the figures', () => {
    const stat = parseRtpAudioQos(fakeRtpAudioQos());
    expect(stat && qosFigures(stat)).toEqual({
      jitterMs: 3.4,
      lossPct: 1,
      rttMs: 42,
      rxPackets: 990,
      txPackets: 1000
    });
  });

  // A device whose audio never reached Asterisk (NAT, a blocked RTP port): the leg sent, but
  // received nothing, which the count keeps where every figure is null.
  it('keeps a received count of 0 on a leg no packet reached', () => {
    const stat = parseRtpAudioQos(
      fakeRtpAudioQos({
        rxcount: 0,
        txcount: 1500,
        rxploss: 1,
        txploss: 0,
        rxjitter: 0,
        txjitter: 0,
        rtt: 0
      })
    );
    expect(stat && qosFigures(stat)).toEqual({
      jitterMs: null,
      lossPct: null,
      rttMs: null,
      rxPackets: 0,
      txPackets: 1500
    });
  });

  it('writes no count the variable does not name', () => {
    const stat = parseRtpAudioQos(
      fakeRtpAudioQos({ rxcount: null, txcount: null })
    );
    expect(stat && qosFigures(stat)).toMatchObject({
      rxPackets: null,
      txPackets: null
    });
  });
});
