import { describe, expect, it } from 'vitest';

import { stackDomain, stackIpv4 } from './stackAddress.js';

describe('stackDomain', () => {
  it("reads the FQDN from ORIGIN's host", () => {
    expect(stackDomain({ ORIGIN: 'https://pbx.example.com' })).toBe(
      'pbx.example.com'
    );
  });

  it('is null while ORIGIN is unset, empty or unparseable', () => {
    expect(stackDomain({})).toBeNull();
    expect(stackDomain({ ORIGIN: '' })).toBeNull();
    // `https://${FQDN}` with FQDN unset: Compose renders `https://`.
    expect(stackDomain({ ORIGIN: 'https://' })).toBeNull();
  });
});

describe('stackIpv4', () => {
  it('takes STACK_IPV4 in the macvlan mode', () => {
    expect(stackIpv4({ STACK_IPV4: '203.0.113.34', EXTERNAL_IPV4: '' })).toBe(
      '203.0.113.34'
    );
  });

  it('takes EXTERNAL_IPV4 in the ports mode', () => {
    expect(stackIpv4({ STACK_IPV4: '', EXTERNAL_IPV4: '198.51.100.7' })).toBe(
      '198.51.100.7'
    );
  });

  it('prefers EXTERNAL_IPV4, the address SIP and SDP name, when both are set (§9.1)', () => {
    expect(
      stackIpv4({ STACK_IPV4: '203.0.113.34', EXTERNAL_IPV4: '198.51.100.7' })
    ).toBe('198.51.100.7');
  });

  it('is null while neither is set', () => {
    expect(stackIpv4({})).toBeNull();
    expect(stackIpv4({ STACK_IPV4: '', EXTERNAL_IPV4: '' })).toBeNull();
  });
});
