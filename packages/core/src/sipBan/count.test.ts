import { describe, expect, it } from 'vitest';

import { SipBanCount, sourceOf, type SipBanThresholds } from './count.js';

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

describe('sourceOf', () => {
  it('reads the address and protocol of an Asterisk RemoteAddress, TCP and TLS alike', () => {
    expect(sourceOf('IPV4/UDP/203.0.113.7/5060')).toEqual({
      address: '203.0.113.7',
      protocol: 'udp'
    });
    expect(sourceOf('IPV4/TCP/203.0.113.7/5060')).toEqual({
      address: '203.0.113.7',
      protocol: 'tcp'
    });
    expect(sourceOf('IPV6/TLS/2001:DB8:1:2:3::9/5061')).toEqual({
      address: '2001:db8:1:2::/64',
      protocol: 'tcp'
    });
  });

  it('is null for a value that carries no address or no transport a drop rule covers', () => {
    expect(sourceOf('')).toBeNull();
    expect(sourceOf('IPV4/UDP/nonsense/5060')).toBeNull();
    expect(sourceOf('IPV4/203.0.113.7/5060')).toBeNull();
    expect(sourceOf('IPV4/WS/203.0.113.7/8088')).toBeNull();
  });
});

describe('SipBanCount', () => {
  it('reports the address once its failures reach the threshold, then counts afresh', () => {
    const { count } = rig();
    expect(count.record(security('InvalidAccountID'), THRESHOLDS)).toBeNull();
    expect(count.record(security('InvalidPassword'), THRESHOLDS)).toBeNull();
    expect(
      count.record(security('ChallengeResponseFailed'), THRESHOLDS)
    ).toEqual({ address: '203.0.113.7', protocol: 'udp', failures: 3 });
    expect(count.record(security('FailedACL'), THRESHOLDS)).toBeNull();
    expect(count.record(security('FailedACL'), THRESHOLDS)).toBeNull();
    expect(count.record(security('FailedACL'), THRESHOLDS)).toEqual({
      address: '203.0.113.7',
      protocol: 'udp',
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
    ).toEqual({
      address: '2001:db8::/64',
      protocol: 'udp',
      failures: 3
    });
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
      protocol: 'udp',
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

  it('counts and reports each protocol of an address on its own, TCP and TLS together', () => {
    const { count } = rig();
    const udp = 'IPV4/UDP/203.0.113.7/5060';
    count.record(security('InvalidAccountID', udp), THRESHOLDS);
    count.record(security('InvalidAccountID', udp), THRESHOLDS);
    count.record(
      security('InvalidAccountID', 'IPV4/TCP/203.0.113.7/5060'),
      THRESHOLDS
    );
    count.record(
      security('InvalidAccountID', 'IPV4/TLS/203.0.113.7/5061'),
      THRESHOLDS
    );
    // Spoofed UDP failures never add up with TCP ones: three over UDP ban UDP alone.
    expect(count.record(security('InvalidAccountID', udp), THRESHOLDS)).toEqual(
      { address: '203.0.113.7', protocol: 'udp', failures: 3 }
    );
    expect(
      count.record(
        security('InvalidAccountID', 'IPV4/TLS/203.0.113.7/5061'),
        THRESHOLDS
      )
    ).toEqual({ address: '203.0.113.7', protocol: 'tcp', failures: 3 });
  });

  it('exempts only the protocol a success came over, TCP and TLS together', () => {
    const { count } = rig();
    count.record(
      security('SuccessfulAuth', 'IPV4/TLS/203.0.113.7/5061'),
      THRESHOLDS
    );
    for (let round = 0; round < THRESHOLDS.sipBanFailures; round += 1) {
      expect(
        count.record(
          security('InvalidAccountID', 'IPV4/TCP/203.0.113.7/5060'),
          THRESHOLDS
        )
      ).toBeNull();
    }
    for (let round = 1; round < THRESHOLDS.sipBanFailures; round += 1) {
      count.record(security('InvalidAccountID'), THRESHOLDS);
    }
    expect(count.record(security('InvalidAccountID'), THRESHOLDS)).toEqual({
      address: '203.0.113.7',
      protocol: 'udp',
      failures: 3
    });
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

describe('SipBanCount and the own endpoints of the stack', () => {
  const own = new Set(['e200-dk3x7']);

  it('does not count an InvalidAccountID for an endpoint the stack renders', () => {
    // A device's first request, without credentials, or one before Asterisk has loaded its
    // endpoint (TASK-54): ten of them behind one office address must not ban it.
    const { count } = rig();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        count.record(
          { ...security('InvalidAccountID'), AccountID: 'e200-dk3x7' },
          THRESHOLDS,
          own
        )
      ).toBeNull();
    }
    expect(count.size).toBe(0);
  });

  it('still counts an unknown account name, and a wrong password for an own endpoint', () => {
    const { count } = rig();
    count.record(
      { ...security('InvalidAccountID'), AccountID: '100' },
      THRESHOLDS,
      own
    );
    count.record(
      { ...security('ChallengeResponseFailed'), AccountID: 'e200-dk3x7' },
      THRESHOLDS,
      own
    );
    expect(
      count.record(
        { ...security('InvalidAccountID'), AccountID: 'admin' },
        THRESHOLDS,
        own
      )
    ).toEqual({ address: '203.0.113.7', protocol: 'udp', failures: 3 });
  });
});
