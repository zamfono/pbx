import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import type { LookupFn } from '../hep.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import {
  exemption,
  ownAddresses,
  type ExemptConfig,
  type OwnAddresses
} from './exempt.js';

const NONE: ExemptConfig = {
  sipAllowlist: [],
  devices: [],
  trunks: [],
  trunkHosts: []
};

const OWN: OwnAddresses = {
  stack: ['127.0.0.0/8', '::1/128', '192.0.2.10'],
  internal: ['172.18.0.0/16']
};

function noLookup(): Promise<{ address: string }[]> {
  return Promise.reject(new Error('no lookup expected'));
}

function check(
  key: string,
  config: Partial<ExemptConfig> = {},
  lookup: LookupFn = noLookup
): Promise<string | null> {
  return exemption(key, { ...NONE, ...config }, OWN, lookup, noopLogger);
}

describe('ownAddresses', () => {
  it('holds loopback, STACK_IPV4, EXTERNAL_IPV4 and the subnets of the non-loopback interfaces', () => {
    const iface = (cidr: string, internal: boolean): NetworkInterfaceInfo =>
      ({ cidr, internal }) as unknown as NetworkInterfaceInfo;
    expect(
      ownAddresses(
        { stackIpv4: null, externalIpv4: '198.51.100.1' },
        {
          lo: [iface('127.0.0.1/8', true)],
          eth0: [iface('172.18.0.3/16', false), iface('fe80::1/64', false)]
        }
      )
    ).toEqual({
      stack: ['127.0.0.0/8', '::1/128', '198.51.100.1'],
      internal: ['172.18.0.3/16', 'fe80::1/64']
    });
  });
});

describe('exemption', () => {
  it('exempts nothing for a stranger', async () => {
    await expect(check('203.0.113.7')).resolves.toBeNull();
  });

  it("names core's subnet of the internal network apart from the other exemptions", async () => {
    await expect(check('172.18.0.1')).resolves.toBe('internalNetwork');
  });

  it("exempts the stack's own addresses", async () => {
    await expect(check('127.0.0.1')).resolves.toBe('listed');
    await expect(check('192.0.2.10')).resolves.toBe('listed');
  });

  it('exempts an allowlist entry or a device allowlist covering the address', async () => {
    await expect(
      check('203.0.113.7', { sipAllowlist: [{ address: '203.0.113.0/24' }] })
    ).resolves.toBe('listed');
    await expect(
      check('203.0.113.7', {
        devices: [{ allowedIps: null }, { allowedIps: ['203.0.113.7'] }]
      })
    ).resolves.toBe('listed');
  });

  it('exempts an IPv6 /64 that holds an allowlisted address or lies in an allowlisted range', async () => {
    await expect(
      check('2001:db8:1:2::/64', {
        sipAllowlist: [{ address: '2001:db8:1:2::5' }]
      })
    ).resolves.toBe('listed');
    await expect(
      check('2001:db8:1:2::/64', {
        sipAllowlist: [{ address: '2001:db8::/32' }]
      })
    ).resolves.toBe('listed');
    await expect(
      check('2001:db8:1:3::/64', {
        sipAllowlist: [{ address: '2001:db8:1:2::5' }]
      })
    ).resolves.toBeNull();
  });

  it('exempts the inbound and both hosts of a live trunk, never its outbound ones', async () => {
    const trunks = [{ id: 't1' }];
    await expect(
      check('203.0.113.7', {
        trunks,
        trunkHosts: [
          { trunkId: 't1', host: '203.0.113.7', direction: 'outbound' },
          { trunkId: 'gone', host: '203.0.113.7', direction: 'both' }
        ]
      })
    ).resolves.toBeNull();
    await expect(
      check('203.0.113.7', {
        trunks,
        trunkHosts: [
          { trunkId: 't1', host: '203.0.113.0/28', direction: 'inbound' }
        ]
      })
    ).resolves.toBe('listed');
  });

  it('resolves a trunk FQDN when asked, and a lookup failure exempts nothing', async () => {
    const trunks = [{ id: 't1' }];
    const trunkHosts = [
      { trunkId: 't1', host: 'sip.example.com', direction: 'both' as const }
    ];
    const resolving = (host: string): Promise<{ address: string }[]> =>
      Promise.resolve(
        host === 'sip.example.com'
          ? [{ address: '198.51.100.2' }, { address: '203.0.113.7' }]
          : []
      );
    await expect(
      check('203.0.113.7', { trunks, trunkHosts }, resolving)
    ).resolves.toBe('listed');
    await expect(
      check('203.0.113.7', { trunks, trunkHosts })
    ).resolves.toBeNull();
  });
});
