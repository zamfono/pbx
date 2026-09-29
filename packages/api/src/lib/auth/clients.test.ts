import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { keyringFromEnv } from '../secretbox.js';
import {
  decodeMetadataClientId,
  encodeMetadataClientId,
  fetchCimd
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
