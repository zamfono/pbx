import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { keyringFromEnv } from '../secretbox.js';
import {
  decodeMetadataClientId,
  encodeMetadataClientId,
  fetchCimd,
  redirectUriAllowed,
  type ClientMeta
} from './clients.js';

const KEY_BYTE_LENGTH = 32;

function keySpec(generation: number): string {
  return `${generation}:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;
}

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
          /* eslint-disable camelcase -- RFC 7591 mandates these snake_case wire fields */
          JSON.stringify({
            client_id: 'https://attacker.example/metadata.json',
            client_name: 'Impostor',
            redirect_uris: ['https://client.example/callback'],
            application_type: 'web'
          }),
          /* eslint-enable camelcase -- RFC 7591 mandates these snake_case wire fields */
          { headers: { 'content-type': 'application/json' } }
        )
      )) as typeof fetch;
    expect(await fetchCimd(url, fetchImpl)).toBeNull();
  });

  it('refuses a non-HTTPS client id', async () => {
    expect(await fetchCimd('http://client.example/metadata.json')).toBeNull();
  });

  it('reads a document without application_type as a web client', async () => {
    // claude.ai's own document, as it served it on 2026-09-29.
    const url = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          /* eslint-disable camelcase -- RFC 7591 mandates these snake_case wire fields */
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
          /* eslint-enable camelcase -- RFC 7591 mandates these snake_case wire fields */
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
          /* eslint-disable camelcase -- RFC 7591 mandates these snake_case wire fields */
          JSON.stringify({
            client_id: url,
            client_name: 'Odd',
            redirect_uris: ['https://client.example/callback'],
            application_type: 'service'
          }),
          /* eslint-enable camelcase -- RFC 7591 mandates these snake_case wire fields */
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
          /* eslint-disable camelcase -- RFC 7591 mandates these snake_case wire fields */
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
          /* eslint-enable camelcase -- RFC 7591 mandates these snake_case wire fields */
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
