import { describe, expect, it } from 'vitest';

import { stackDomain, stackIpv4, stackOrigin } from './stackAddress.js';

describe('stackDomain', () => {
  it('reads FQDN', () => {
    expect(stackDomain({ FQDN: 'pbx.example.com' })).toBe('pbx.example.com');
  });

  it('is null while FQDN is unset or empty', () => {
    expect(stackDomain({})).toBeNull();
    // Compose hands `${FQDN}` to `api` as an empty string while `.env` leaves it unset.
    expect(stackDomain({ FQDN: '' })).toBeNull();
  });
});

describe('stackOrigin', () => {
  it('is the https origin of the FQDN', () => {
    expect(stackOrigin('pbx.example.com')).toBe('https://pbx.example.com');
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
