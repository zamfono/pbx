import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { encrypt, keyringFromEnv, type Keyring } from '../secretbox.js';
import { createRingotelClient, RingotelError } from './ringotelClient.js';

const KEY_BYTE_LENGTH = 32;
const API_TOKEN = 'ringotel-admin-key';
const TEST_TIMEOUT_MS = 5;

function testKeyring(): Keyring {
  return keyringFromEnv({
    SECRETBOX_KEY: `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`
  });
}

type FetchCall = {
  url: string;
  body: unknown;
  headers: Record<string, string>;
};

/** A fake `fetch` recording every call and answering with `result` for every request. */
function fakeFetch(result: unknown): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(init?.body as string),
      headers: init?.headers as Record<string, string>
    });
    return Promise.resolve(
      new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('createRingotelClient', () => {
  it("refuses a result that carries Ringotel's own error, as createUser answers a failed registration", async () => {
    // Ringotel's answer on 2026-09-29, HTTP 200 and no top-level `error`, which created no user.
    const keyring = testKeyring();
    const { fetchImpl } = fakeFetch({
      error: 'zamfono-test-e998-d1xyy5 registration failed - Unauthorized',
      status: -1
    });
    const client = createRingotelClient(
      { ringotelApiTokenEnc: encrypt(keyring, API_TOKEN) },
      keyring,
      fetchImpl
    );

    const call = client.call('createUser', { extension: '998' });
    await expect(call).rejects.toBeInstanceOf(RingotelError);
    await expect(call).rejects.toMatchObject({
      status: 502,
      method: 'createUser',
      ringotelMessage:
        'zamfono-test-e998-d1xyy5 registration failed - Unauthorized'
    });
  });

  it("reads a top-level error's message", async () => {
    const keyring = testKeyring();
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: 'Domain zamfono-test.ringotel.co already exists' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )) as typeof fetch;
    const client = createRingotelClient(
      { ringotelApiTokenEnc: encrypt(keyring, API_TOKEN) },
      keyring,
      fetchImpl
    );

    await expect(client.call('createOrganization')).rejects.toMatchObject({
      status: 502,
      ringotelMessage: 'Domain zamfono-test.ringotel.co already exists'
    });
  });

  it('POSTs {method, params} with a bearer token decrypted from ringotelApiTokenEnc', async () => {
    const keyring = testKeyring();
    const { fetchImpl, calls } = fakeFetch({ id: 'org-1' });
    const client = createRingotelClient(
      { ringotelApiTokenEnc: encrypt(keyring, API_TOKEN) },
      keyring,
      fetchImpl
    );

    const result = await client.call('createOrganization', { name: 'Acme' });

    expect(result).toEqual({ id: 'org-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://shell.ringotel.co/api');
    expect(calls[0]?.body).toEqual({
      method: 'createOrganization',
      params: { name: 'Acme' }
    });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
  });

  it('throws when settings carries no API token', () => {
    const keyring = testKeyring();
    expect(() =>
      createRingotelClient(
        { ringotelApiTokenEnc: null },
        keyring,
        fakeFetch({}).fetchImpl
      )
    ).toThrow(/no API token/u);
  });

  it('throws when the Ringotel response carries an error', async () => {
    const keyring = testKeyring();
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'bad request' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )) as typeof fetch;
    const client = createRingotelClient(
      { ringotelApiTokenEnc: encrypt(keyring, API_TOKEN) },
      keyring,
      fetchImpl
    );

    await expect(client.call('createOrganization', {})).rejects.toThrow(
      /bad request/u
    );
  });

  it('aborts a request that outlives the timeout', async () => {
    const keyring = testKeyring();
    // Answers only once the request is aborted, so the call can end only through the timeout.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by signal'));
        });
      })) as typeof fetch;
    const client = createRingotelClient(
      { ringotelApiTokenEnc: encrypt(keyring, API_TOKEN) },
      keyring,
      fetchImpl,
      TEST_TIMEOUT_MS
    );

    await expect(client.call('getUsers', {})).rejects.toThrow(
      /'getUsers' timed out after 5 ms/u
    );
  });
});
