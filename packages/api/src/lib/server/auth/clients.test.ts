import { isIP } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { keySpec } from '#testing/fixtures.js';

import { keyringFromEnv } from '../secretbox.js';
import {
  clientMetaFor,
  decodeMetadataClientId,
  encodeMetadataClientId,
  fetchCimd,
  type ClientMeta
} from './clients.js';
import { redirectUriAllowed } from './redirectUris.js';

// A documentation-range address stands for every name a test resolves; an IP literal resolves to
// itself, as the real lookup does.
const PUBLIC_ADDRESS = '203.0.113.10';
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

beforeEach(() => {
  lookup.mockImplementation((host: string) =>
    Promise.resolve([
      isIP(host) === 0
        ? { address: PUBLIC_ADDRESS, family: 4 }
        : { address: host, family: isIP(host) }
    ])
  );
});

/** A valid Client ID Metadata Document served at `url`. */
function cimdDocument(url: string): Record<string, unknown> {
  return {
    client_id: url,
    client_name: 'Client',
    redirect_uris: ['https://client.example/callback'],
    application_type: 'web'
  };
}

describe('clientMetaFor', () => {
  it('decodes, never fetches, a client id that is not an https URL', async () => {
    const kr = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    expect(
      await clientMetaFor(kr, 'http://client.example/metadata.json')
    ).toBeNull();
  });
});

describe('encodeMetadataClientId / decodeMetadataClientId', () => {
  it('round-trips the metadata through encode and decode', () => {
    const kr = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const clientId = encodeMetadataClientId(kr, {
      name: 'My CLI',
      redirectUris: ['http://127.0.0.1:0/callback'],
      applicationType: 'native'
    });
    expect(decodeMetadataClientId(kr, clientId)).toEqual({
      clientId,
      kind: 'metadata',
      name: 'My CLI',
      redirectUris: ['http://127.0.0.1:0/callback'],
      applicationType: 'native'
    });
  });

  it('refuses a client id encrypted under a key generation the keyring no longer holds', () => {
    const written = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const clientId = encodeMetadataClientId(written, {
      name: 'Old client',
      redirectUris: ['https://example.test/callback'],
      applicationType: 'web'
    });
    const rotated = keyringFromEnv({ SECRETBOX_KEY: keySpec(2) });
    expect(decodeMetadataClientId(rotated, clientId)).toBeNull();
  });
});

describe('fetchCimd', () => {
  it('rejects a document whose client_id differs from its own URL', async () => {
    const url = 'https://client.example/metadata.json';
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: 'https://attacker.example/metadata.json',
            client_name: 'Impostor',
            redirect_uris: ['https://client.example/callback'],
            application_type: 'web'
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )) as typeof fetch;
    expect(await fetchCimd(url, fetchImpl)).toBeNull();
  });

  it('answers null for a document whose host is unreachable', async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect(
      await fetchCimd('https://down.example/metadata.json', fetchImpl)
    ).toBeNull();
  });

  it('answers null for a document that is not JSON', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('<html>oops</html>'))) as typeof fetch;
    expect(
      await fetchCimd('https://html.example/metadata.json', fetchImpl)
    ).toBeNull();
  });

  it('answers null for a document larger than the size cap', async () => {
    const url = 'https://big.example/metadata.json';
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ...cimdDocument(url), padding: 'x'.repeat(65_536) })
        )
      )) as typeof fetch;
    expect(await fetchCimd(url, fetchImpl)).toBeNull();
  });

  it('gives the fetch a deadline', async () => {
    const url = 'https://slow.example/metadata.json';
    let signal: AbortSignal | null | undefined;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return Promise.resolve(new Response(JSON.stringify(cimdDocument(url))));
    }) as typeof fetch;
    await fetchCimd(url, fetchImpl);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('does not cache a document marked no-store, whatever its max-age', async () => {
    const url = 'https://nostore.example/metadata.json';
    let fetches = 0;
    const fetchImpl = (() => {
      fetches += 1;
      return Promise.resolve(
        new Response(JSON.stringify(cimdDocument(url)), {
          headers: { 'cache-control': 'no-store, max-age=3600' }
        })
      );
    }) as typeof fetch;
    await fetchCimd(url, fetchImpl);
    await fetchCimd(url, fetchImpl);
    expect(fetches).toBe(2);
  });

  // Anyone can name any URL as `client_id` at `/oauth/authorize`, and the document chooses its
  // own max-age: an unbounded cache lets one client fill api's memory with distinct documents.
  it('keeps a bounded number of documents cached, whatever max-age they ask for', async () => {
    const documents = 20_000;
    const urlOf = (index: number): string =>
      `https://flood.example/${index}.json`;
    const fetched = new Set<string>();
    const fetchImpl = ((input: string) => {
      fetched.add(input);
      return Promise.resolve(
        new Response(JSON.stringify(cimdDocument(input)), {
          headers: { 'cache-control': 'max-age=999999999' }
        })
      );
    }) as typeof fetch;
    for (let index = 0; index < documents; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- one document after another, as a flood of page loads would
      await fetchCimd(urlOf(index), fetchImpl);
    }
    fetched.clear();
    await fetchCimd(urlOf(0), fetchImpl);
    expect(fetched.has(urlOf(0))).toBe(true);
  });

  it('caches a document for at most a day, whatever max-age it asks for', async () => {
    const url = 'https://forever.example/metadata.json';
    let fetches = 0;
    const fetchImpl = (() => {
      fetches += 1;
      return Promise.resolve(
        new Response(JSON.stringify(cimdDocument(url)), {
          headers: { 'cache-control': 'max-age=999999999' }
        })
      );
    }) as typeof fetch;
    vi.useFakeTimers();
    try {
      await fetchCimd(url, fetchImpl);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      await fetchCimd(url, fetchImpl);
    } finally {
      vi.useRealTimers();
    }
    expect(fetches).toBe(2);
  });

  // §5.2: a metadata document meets the limits `/oauth/register` applies.
  it.each([
    ['a client_name over 100 characters', { client_name: 'x'.repeat(101) }],
    ['an empty client_name', { client_name: '' }],
    [
      'more than 5 redirect URIs',
      {
        redirect_uris: Array.from(
          { length: 6 },
          (_entry, index) => `https://client.example/callback/${index}`
        )
      }
    ],
    [
      'a redirect URI over 512 characters',
      { redirect_uris: [`https://client.example/${'x'.repeat(512)}`] }
    ],
    ['no redirect URI', { redirect_uris: [] }]
  ])('refuses a document with %s', async (_case, override) => {
    const url = 'https://limits.example/metadata.json';
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ...cimdDocument(url), ...override }))
      )) as typeof fetch;
    expect(await fetchCimd(url, fetchImpl)).toBeNull();
  });

  it('does not follow a redirect', async () => {
    const url = 'https://moved.example/metadata.json';
    let redirect: RequestRedirect | undefined;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      ({ redirect } = init ?? {});
      return Promise.resolve(new Response(JSON.stringify(cimdDocument(url))));
    }) as typeof fetch;
    await fetchCimd(url, fetchImpl);
    expect(redirect).toBe('error');
  });

  // Anyone can make the server fetch a URL: it never reaches the stack's own network.
  it.each([
    ['loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['unspecified', '0.0.0.0'],
    ['private 10/8', '10.1.2.3'],
    ['private 172.16/12', '172.20.0.5'],
    ['private 192.168/16', '192.168.1.1'],
    ['shared 100.64/10', '100.64.0.1'],
    ['link-local (cloud metadata)', '169.254.169.254'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 unique local', 'fd00::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1']
  ])('refuses a host that resolves to a %s address', async (_case, address) => {
    lookup.mockResolvedValue([
      { address: PUBLIC_ADDRESS, family: 4 },
      { address, family: isIP(address) }
    ]);
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await fetchCimd('https://inside.example/metadata.json', fetchImpl)
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['https://127.0.0.1/metadata.json', 'https://[::1]/metadata.json'])(
    'refuses an IP literal %s on a loopback address',
    async url => {
      const fetchImpl = vi.fn<typeof fetch>();
      expect(await fetchCimd(url, fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('refuses a document whose redirect URI is not an absolute http(s) URI', async () => {
    const url = 'https://relative.example/metadata.json';
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ...cimdDocument(url), redirect_uris: ['callback'] })
        )
      )) as typeof fetch;
    expect(await fetchCimd(url, fetchImpl)).toBeNull();
  });

  it('reads a document without application_type as a web client', async () => {
    // claude.ai's own document, as it served it on 2026-09-29.
    const url = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: url,
            client_name: 'Claude',
            client_uri: 'https://claude.ai',
            redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
            grant_types: [
              'authorization_code',
              'refresh_token',
              'urn:ietf:params:oauth:grant-type:jwt-bearer'
            ],
            response_types: ['code'],
            token_endpoint_auth_method: 'none'
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )) as typeof fetch;
    expect(await fetchCimd(url, fetchImpl)).toEqual({
      clientId: url,
      kind: 'cimd',
      name: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      applicationType: 'web'
    });
  });

  it('still refuses an application_type other than native or web', async () => {
    const url = 'https://client.example/other-type.json';
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: url,
            client_name: 'Odd',
            redirect_uris: ['https://client.example/callback'],
            application_type: 'service'
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )) as typeof fetch;
    expect(await fetchCimd(url, fetchImpl)).toBeNull();
  });
});

describe('redirectUriAllowed', () => {
  const CLAUDE_CODE_CLIENT_ID =
    'https://claude.ai/oauth/claude-code-client-metadata';

  /** Claude Code's own document, as it served it on 2026-10-01: no `application_type`, no port. */
  async function claudeCodeMeta(): Promise<ClientMeta> {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: CLAUDE_CODE_CLIENT_ID,
            client_name: 'Claude Code',
            client_uri: 'https://claude.ai',
            redirect_uris: [
              'http://localhost/callback',
              'http://127.0.0.1/callback'
            ],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none'
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )) as typeof fetch;
    const meta = await fetchCimd(CLAUDE_CODE_CLIENT_ID, fetchImpl);
    if (meta === null) {
      throw new Error("expected Claude Code's document to parse");
    }
    return meta;
  }

  function webClient(redirectUris: string[]): ClientMeta {
    return {
      clientId: 'https://client.example/metadata.json',
      kind: 'cimd',
      name: 'Web',
      redirectUris,
      applicationType: 'web'
    };
  }

  it('allows any port on a registered localhost or 127.0.0.1 URI, though the client is web (RFC 8252 §7.3)', async () => {
    const meta = await claudeCodeMeta();
    expect(meta.applicationType).toBe('web');
    expect(redirectUriAllowed(meta, 'http://localhost:49536/callback')).toBe(
      true
    );
    expect(redirectUriAllowed(meta, 'http://127.0.0.1:1234/callback')).toBe(
      true
    );
    expect(redirectUriAllowed(meta, 'http://localhost/callback')).toBe(true);
  });

  it('refuses another path, query, host, scheme or userinfo on a random port', async () => {
    const meta = await claudeCodeMeta();
    expect(redirectUriAllowed(meta, 'http://localhost:49536/other')).toBe(
      false
    );
    expect(
      redirectUriAllowed(meta, 'http://localhost:49536/callback?x=1')
    ).toBe(false);
    expect(redirectUriAllowed(meta, 'http://evil.example:49536/callback')).toBe(
      false
    );
    expect(redirectUriAllowed(meta, 'https://localhost:49536/callback')).toBe(
      false
    );
    expect(
      redirectUriAllowed(meta, 'http://user@localhost:49536/callback')
    ).toBe(false);
    expect(redirectUriAllowed(meta, 'http://[::1]:49536/callback')).toBe(false);
  });

  it('lets no loopback host stand for another', () => {
    const meta = webClient(['http://localhost/callback']);
    expect(redirectUriAllowed(meta, 'http://127.0.0.1:1234/callback')).toBe(
      false
    );
    expect(redirectUriAllowed(meta, 'http://[::1]:1234/callback')).toBe(false);
    const ipv6 = webClient(['http://[::1]/callback']);
    expect(redirectUriAllowed(ipv6, 'http://[::1]:1234/callback')).toBe(true);
    expect(redirectUriAllowed(ipv6, 'http://localhost:1234/callback')).toBe(
      false
    );
  });

  it('matches a non-loopback URI exactly, port included', () => {
    const meta = webClient(['https://client.example/callback']);
    expect(redirectUriAllowed(meta, 'https://client.example/callback')).toBe(
      true
    );
    expect(
      redirectUriAllowed(meta, 'https://client.example:8443/callback')
    ).toBe(false);
    expect(redirectUriAllowed(meta, 'http://client.example/callback')).toBe(
      false
    );
  });
});
