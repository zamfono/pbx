import { describe, expect, it } from 'vitest';

import { SipBanCount, sourceKey, type SipBanThresholds } from './count.js';

const THRESHOLDS: SipBanThresholds = {
  sipBanFailures: 3,
  sipBanWindowS: 60,
  sipBanSuccessExemptS: 300
};
const MS = 1000;

function security(
  event: string,
  remote = 'IPV4/UDP/203.0.113.7/5060'
): Record<string, string> {
  return { Event: event, Service: 'PJSIP', RemoteAddress: remote };
}

function rig(): { count: SipBanCount; at: (s: number) => void } {
  let nowMs = 0;
  return {
    count: new SipBanCount(() => nowMs),
    at: (seconds: number) => {
      nowMs = seconds * MS;
    }
  };
}

describe('sourceKey', () => {
  it('reads the address of an Asterisk RemoteAddress, with or without transport', () => {
    expect(sourceKey('IPV4/UDP/203.0.113.7/5060')).toBe('203.0.113.7');
    expect(sourceKey('IPV4/203.0.113.7/5060')).toBe('203.0.113.7');
    expect(sourceKey('IPV6/TLS/2001:DB8:1:2:3::9/5061')).toBe(
      '2001:db8:1:2::/64'
    );
  });

  it('is null for a value that carries no address', () => {
    expect(sourceKey('')).toBeNull();
    expect(sourceKey('IPV4/UDP/nonsense/5060')).toBeNull();
  });
});

describe('SipBanCount', () => {
  it('reports the address once its failures reach the threshold, then counts afresh', () => {
    const { count } = rig();
    expect(count.record(security('InvalidAccountID'), THRESHOLDS)).toBeNull();
    expect(count.record(security('InvalidPassword'), THRESHOLDS)).toBeNull();
    expect(
      count.record(security('ChallengeResponseFailed'), THRESHOLDS)
    ).toEqual({ address: '203.0.113.7', failures: 3 });
    expect(count.record(security('FailedACL'), THRESHOLDS)).toBeNull();
    expect(count.record(security('FailedACL'), THRESHOLDS)).toBeNull();
    expect(count.record(security('FailedACL'), THRESHOLDS)).toEqual({
      address: '203.0.113.7',
      failures: 3
    });
  });

  it('never counts ChallengeSent, SuccessfulAuth or other events', () => {
    const { count } = rig();
    for (const event of ['ChallengeSent', 'SuccessfulAuth', 'Registry']) {
      for (let round = 0; round < THRESHOLDS.sipBanFailures; round += 1) {
        expect(count.record(security(event), THRESHOLDS)).toBeNull();
      }
    }
  });

  it('counts an IPv6 source as its /64', () => {
    const { count } = rig();
    count.record(
      security('InvalidAccountID', 'IPV6/UDP/2001:db8::1/5060'),
      THRESHOLDS
    );
    count.record(
      security('InvalidAccountID', 'IPV6/UDP/2001:db8::2/5060'),
      THRESHOLDS
    );
    expect(
      count.record(
        security('InvalidAccountID', 'IPV6/UDP/2001:db8::3/5060'),
        THRESHOLDS
      )
    ).toEqual({ address: '2001:db8::/64', failures: 3 });
  });

  it('counts each address on its own', () => {
    const { count } = rig();
    count.record(
      security('InvalidAccountID', 'IPV4/UDP/203.0.113.7/5060'),
      THRESHOLDS
    );
    count.record(
      security('InvalidAccountID', 'IPV4/UDP/203.0.113.8/5060'),
      THRESHOLDS
    );
    expect(
      count.record(
        security('InvalidAccountID', 'IPV4/UDP/203.0.113.9/5060'),
        THRESHOLDS
      )
    ).toBeNull();
  });

  it('counts only the failures within the sliding window', () => {
    const { count, at } = rig();
    at(0);
    count.record(security('InvalidAccountID'), THRESHOLDS);
    at(30);
    count.record(security('InvalidAccountID'), THRESHOLDS);
    at(61);
    expect(count.record(security('InvalidAccountID'), THRESHOLDS)).toBeNull();
    at(70);
    expect(count.record(security('InvalidAccountID'), THRESHOLDS)).toEqual({
      address: '203.0.113.7',
      failures: 3
    });
  });

  it('exempts an address that authenticated within sip_ban_success_exempt_s', () => {
    const { count, at } = rig();
    at(0);
    count.record(security('SuccessfulAuth'), THRESHOLDS);
    at(300);
    for (let round = 0; round < THRESHOLDS.sipBanFailures; round += 1) {
      expect(count.record(security('InvalidAccountID'), THRESHOLDS)).toBeNull();
    }
    at(301);
    for (let round = 1; round < THRESHOLDS.sipBanFailures; round += 1) {
      count.record(security('InvalidAccountID'), THRESHOLDS);
    }
    expect(
      count.record(security('InvalidAccountID'), THRESHOLDS)
    ).not.toBeNull();
  });

  it('exempts nothing for a success with sip_ban_success_exempt_s 0', () => {
    const { count } = rig();
    const thresholds = { ...THRESHOLDS, sipBanSuccessExemptS: 0 };
    count.record(security('SuccessfulAuth'), thresholds);
    count.record(security('InvalidAccountID'), thresholds);
    count.record(security('InvalidAccountID'), thresholds);
    expect(
      count.record(security('InvalidAccountID'), thresholds)
    ).not.toBeNull();
  });

  it('drops the addresses whose window and exemption passed at a sweep', () => {
    const { count, at } = rig();
    at(0);
    for (let round = 0; round < 1000; round += 1) {
      count.record(
        security('InvalidAccountID', `IPV4/UDP/198.51.100.${round % 250}/5060`),
        THRESHOLDS
      );
      count.record(
        security('SuccessfulAuth', `IPV4/UDP/192.0.2.${round % 250}/5060`),
        THRESHOLDS
      );
    }
    at(59);
    count.record(
      security('InvalidAccountID', 'IPV4/UDP/203.0.113.7/5060'),
      THRESHOLDS
    );
    at(61);
    count.sweep(THRESHOLDS);
    // 203.0.113.7's failure and the 250 successes
    expect(count.size).toBe(251);
    at(301);
    count.sweep(THRESHOLDS);
    expect(count.size).toBe(0);
  });
});
