import { describe, expect, it } from 'vitest';

import { originFromEnv, stackIpv4 } from './stackAddress.js';

describe('originFromEnv', () => {
  it('is the https origin of the FQDN', () => {
    expect(originFromEnv()).toBe('https://pbx.test');
  });
});

describe('stackIpv4', () => {
  it('takes STACK_IPV4 in the macvlan mode', () => {
    expect(stackIpv4({ STACK_IPV4: '203.0.113.34' })).toBe('203.0.113.34');
  });

  it('takes EXTERNAL_IPV4 in the ports mode', () => {
    expect(stackIpv4({ EXTERNAL_IPV4: '198.51.100.7' })).toBe('198.51.100.7');
  });

  it('prefers EXTERNAL_IPV4, the address SIP and SDP name, when both are set (§9.1)', () => {
    expect(
      stackIpv4({ STACK_IPV4: '203.0.113.34', EXTERNAL_IPV4: '198.51.100.7' })
    ).toBe('198.51.100.7');
  });

  it('is null while neither is set', () => {
    expect(stackIpv4({})).toBeNull();
  });
});
