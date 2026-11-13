import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import {
  FORBIDDEN_ADDRESS_CODE,
  isForbiddenAddress,
  isForbiddenAddressError,
  isForbiddenLiteral,
  ownSubnets,
  resolveTarget,
  targetLookup,
  type TargetPolicy
} from './outboundTargets.js';

vi.mock('node:dns', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns')>();
  // `stack.test` and `lan.test` resolve as the stack's and a LAN's names would; `mixed.test` to
  // a public address and a loopback one, as a rebinding answer could; an IP literal to itself.
  const answers: Record<string, LookupAddress[]> = {
    'public.test': [{ address: '203.0.113.7', family: 4 }],
    'lan.test': [{ address: '192.168.1.20', family: 4 }],
    'stack.test': [{ address: '172.30.0.5', family: 4 }],
    'mixed.test': [
      { address: '203.0.113.7', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ],
    'metadata.test': [{ address: '169.254.169.254', family: 4 }],
    'v6.test': [{ address: '2001:db8::1', family: 6 }]
  };
  return {
    ...actual,
    lookup: (
      host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void
    ) => {
      const family = isIP(host);
      const answer = family === 0 ? answers[host] : [{ address: host, family }];
      if (answer === undefined) {
        callback(
          Object.assign(new Error('not found'), { code: 'ENOTFOUND' }),
          []
        );
      } else {
        callback(null, answer);
      }
    }
  };
});

// This container's interfaces, as `ownSubnets()` reads them by default: loopback and the
// `internal` network's, a private subnet the policy refuses even with private targets allowed.
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: () => ({
    lo: [{ internal: true, cidr: '127.0.0.1/8' }],
    eth0: [{ internal: false, cidr: '10.77.3.5/24' }]
  })
}));

// The stack's own `internal` network, as `api` and `core` read it from their interfaces.
const OWN = ['172.30.0.0/16'];
const PRIVATE_ALLOWED: TargetPolicy = { allowPrivate: true, ownSubnets: OWN };
const PRIVATE_REFUSED: TargetPolicy = { allowPrivate: false, ownSubnets: OWN };

describe('isForbiddenAddress (§3.1 "Outbound targets")', () => {
  it.each([
    // always refused
    ['127.0.0.1', true, true],
    ['127.8.9.10', true, true],
    ['::1', true, true],
    ['::ffff:127.0.0.1', true, true],
    ['0.0.0.0', true, true],
    ['::', true, true],
    ['169.254.169.254', true, true],
    ['fe80::1', true, true],
    // the stack's own subnet
    ['172.30.0.5', true, true],
    // private: allowed unless ALLOW_PRIVATE_TARGETS=false
    ['10.1.2.3', false, true],
    ['172.16.0.1', false, true],
    ['172.31.255.254', false, true],
    ['192.168.1.20', false, true],
    ['100.64.0.1', false, true],
    ['fd00::1', false, true],
    ['::ffff:192.168.1.20', false, true],
    // public
    ['203.0.113.7', false, false],
    ['8.8.8.8', false, false],
    ['172.32.0.1', false, false],
    ['2001:db8::1', false, false]
  ])(
    '%s: refused with private allowed %s, with private refused %s',
    (address, allowed, refused) => {
      expect(isForbiddenAddress(address, PRIVATE_ALLOWED)).toBe(allowed);
      expect(isForbiddenAddress(address, PRIVATE_REFUSED)).toBe(refused);
    }
  );
});

describe('isForbiddenLiteral', () => {
  it.each([
    ['127.0.0.1', true],
    ['[::1]', true],
    ['[fe80::1]', true],
    ['172.30.0.9', true],
    ['192.168.1.20', false],
    ['[2001:db8::1]', false],
    ['localhost', false],
    ['core', false]
  ])(
    '%s is %s with private networks allowed (a name is the lookup’s)',
    (host, expected) => {
      expect(isForbiddenLiteral(host, PRIVATE_ALLOWED)).toBe(expected);
    }
  );

  it('refuses a private literal with private networks refused', () => {
    expect(isForbiddenLiteral('192.168.1.20', PRIVATE_REFUSED)).toBe(true);
  });
});

describe('ownSubnets', () => {
  it("reads the subnets of the container's interfaces besides loopback", () => {
    expect(
      ownSubnets({
        lo: [{ internal: true, cidr: '127.0.0.1/8' }],
        eth0: [
          { internal: false, cidr: '172.30.0.5/16' },
          { internal: false, cidr: 'fe80::42/64' }
        ]
      })
    ).toEqual(['172.30.0.5/16', 'fe80::42/64']);
  });

  it('is the default subnet list of a policy without one', () => {
    expect(ownSubnets()).toEqual(['10.77.3.5/24']);
    const policy: TargetPolicy = { allowPrivate: true };
    expect(isForbiddenLiteral('10.77.3.200', policy)).toBe(true);
    expect(isForbiddenLiteral('10.77.4.200', policy)).toBe(false);
    expect(isForbiddenLiteral('192.168.1.20', policy)).toBe(false);
  });
});

/** `targetLookup(policy)` for `host`, as a socket calls it. */
function lookupOf(
  policy: TargetPolicy,
  host: string,
  all = false
): Promise<{ error: NodeJS.ErrnoException | null; address: unknown }> {
  return new Promise(resolve => {
    targetLookup(policy)(host, { all }, (error, address) => {
      resolve({ error, address });
    });
  });
}

describe('targetLookup', () => {
  it('answers an allowed name as the default lookup does', async () => {
    expect(await lookupOf(PRIVATE_ALLOWED, 'public.test')).toEqual({
      error: null,
      address: '203.0.113.7'
    });
    expect(await lookupOf(PRIVATE_ALLOWED, 'lan.test', true)).toEqual({
      error: null,
      address: [{ address: '192.168.1.20', family: 4 }]
    });
  });

  it.each([
    [PRIVATE_ALLOWED, 'stack.test'],
    [PRIVATE_ALLOWED, 'mixed.test'],
    [PRIVATE_ALLOWED, 'metadata.test'],
    [PRIVATE_REFUSED, 'lan.test']
  ])('fails a name with any refused address (%o, %s)', async (policy, host) => {
    const { error } = await lookupOf(policy, host);
    expect(error?.code).toBe(FORBIDDEN_ADDRESS_CODE);
    expect(
      isForbiddenAddressError(new Error('wrapped', { cause: error }))
    ).toBe(true);
  });

  it('passes a failed resolution on as it is', async () => {
    const { error } = await lookupOf(PRIVATE_ALLOWED, 'nowhere.test');
    expect(error?.code).toBe('ENOTFOUND');
    expect(isForbiddenAddressError(error)).toBe(false);
  });
});

describe('resolveTarget (§6.5: before a backup tool is spawned)', () => {
  it('answers the addresses of an allowed host, or the literal itself', async () => {
    expect(await resolveTarget('public.test', PRIVATE_ALLOWED)).toEqual([
      '203.0.113.7'
    ]);
    expect(await resolveTarget('192.168.1.20', PRIVATE_ALLOWED)).toEqual([
      '192.168.1.20'
    ]);
    expect(await resolveTarget('[2001:db8::1]', PRIVATE_ALLOWED)).toEqual([
      '2001:db8::1'
    ]);
  });

  it.each([
    [PRIVATE_ALLOWED, 'stack.test'],
    [PRIVATE_ALLOWED, 'mixed.test'],
    [PRIVATE_ALLOWED, '127.0.0.1'],
    [PRIVATE_ALLOWED, '169.254.169.254'],
    [PRIVATE_REFUSED, 'lan.test'],
    [PRIVATE_REFUSED, '10.0.0.1']
  ])(
    'rejects a host with any refused address (%o, %s)',
    async (policy, host) => {
      await expect(resolveTarget(host, policy)).rejects.toMatchObject({
        code: FORBIDDEN_ADDRESS_CODE
      });
    }
  );
});
