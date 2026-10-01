import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateForTest } from '@zamfono/shared/testDb.js';

import { GET } from '#routes/oauth/callback/+server.js';

import { getDb } from '../db.js';
import { keyringFromEnv } from '../secretbox.js';
import { encodeMetadataClientId } from './clients.js';
import { CONSENT_COOKIE_NAME } from './consent.js';
import {
  discover,
  finishLogin,
  sealPendingLogin,
  SSO_COOKIE_NAME,
  ssoConfigFromSettings
} from './sso.js';

const KEY_BYTE_LENGTH = 32;

process.env.DB_FILE = ':memory:';
process.env.ORIGIN = 'https://pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

vi.mock('./sso.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./sso.js')>();
  return {
    ...actual,
    ssoConfigFromSettings: vi.fn(),
    discover: vi.fn(),
    finishLogin: vi.fn()
  };
});

const ssoConfigFromSettingsMock = vi.mocked(ssoConfigFromSettings);
const discoverMock = vi.mocked(discover);
const finishLoginMock = vi.mocked(finishLogin);

beforeAll(async () => {
  // No `settings` row: `ssoConfigFromSettings` then answers `null`, which the handler reports as
  // the `noUser` error page — enough to prove a request cleared the cookie/query state check
  // without needing a full SSO provider stubbed in.
  await migrateForTest(getDb());
});

beforeEach(() => {
  // Each of the three mocked functions above defaults back to returning `undefined`, which the
  // handler treats the same as `ssoConfigFromSettings`'s real "unconfigured" `null` (§5.2 "Login
  // and SSO") for the tests below that stub none of them.
  ssoConfigFromSettingsMock.mockReset();
  discoverMock.mockReset();
  finishLoginMock.mockReset();
});

/** A `RequestEvent` for `GET /oauth/callback?state=...&code=...` presenting `cookie` (a full
 *  `Set-Cookie` string, or `undefined` for none). `sets` collects every `cookies.set` call, for
 *  tests asserting the handler seals a consent cookie rather than minting a code directly. */
function eventFor(
  query: string,
  cookie: string | undefined,
  sets: { name: string; value: string }[] = []
): RequestEvent {
  const url = new URL(`https://pbx.example.com/oauth/callback?${query}`);
  return {
    url,
    cookies: {
      get: (name: string) =>
        name === SSO_COOKIE_NAME && cookie !== undefined
          ? cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))
          : undefined,
      set: (name: string, value: string) => {
        sets.push({ name, value });
      },
      delete: () => undefined
    }
  } as unknown as RequestEvent;
}

/** The `reason` query parameter of a thrown `Redirect`'s location, asserting it points at
 *  `/auth/error`. */
function errorReasonOf(err: unknown): string | null {
  if (!isRedirect(err)) {
    throw new Error('expected GET to redirect');
  }
  const location = new URL(err.location, 'https://pbx.example.com');
  expect(location.pathname).toBe('/auth/error');
  return location.searchParams.get('reason');
}

describe('GET /oauth/callback', () => {
  it('proceeds past the cookie/query state check when the cookie matches the browser', async () => {
    const cookie = sealPendingLogin({
      state: 'state-1',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      authorizeParams: null
    });
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const err = await GET(
      eventFor('state=state-1&code=auth-code', cookie)
    ).catch((caught: unknown) => caught);
    // Reaches the (unconfigured) SSO lookup instead of being turned away at the state check.
    expect(errorReasonOf(err)).toBe('noUser');
  });

  it("refuses a code/state pair presented with another login's cookie", async () => {
    const cookie = sealPendingLogin({
      state: 'attacker-state',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      authorizeParams: null
    });
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const err = await GET(
      eventFor('state=victim-state&code=victim-code', cookie)
    ).catch((caught: unknown) => caught);
    const reason = errorReasonOf(err);
    expect(reason).toBe('expired');
    // No authorization code is ever minted: the handler returns at the state check.
    expect(isRedirect(err) && err.location).not.toContain('code=');
  });

  it('refuses a code/state pair presented with no cookie at all', async () => {
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const err = await GET(
      eventFor('state=victim-state&code=victim-code', undefined)
    ).catch((caught: unknown) => caught);
    expect(errorReasonOf(err)).toBe('expired');
  });

  it('routes a successful SSO login for an outer client through the consent step instead of minting a code directly (§5.2 "Client rows", "Authentication pages")', async () => {
    const kr = keyringFromEnv(process.env);
    const clientId = encodeMetadataClientId(kr, {
      name: 'SSO Test Client',
      redirectUris: ['https://client.example.com/callback'],
      applicationType: 'web'
    });
    ssoConfigFromSettingsMock.mockResolvedValue({
      provider: 'oidc',
      issuer: 'https://idp.example.com',
      clientId: 'idp-client',
      clientSecret: null,
      tenantId: null,
      allowedDomain: null,
      label: 'IdP'
    });
    discoverMock.mockResolvedValue({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      issuer: 'https://idp.example.com'
    });
    finishLoginMock.mockResolvedValue({ ok: true, userId: 'user-1' });
    const cookie = sealPendingLogin({
      state: 'state-1',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      authorizeParams: {
        clientId,
        redirectUri: 'https://client.example.com/callback',
        codeChallenge: 'challenge-1',
        scope: 'openid',
        state: 'outer-state-1'
      }
    });
    const sets: { name: string; value: string }[] = [];
    // eslint-disable-next-line new-cap -- GET is the fixed SvelteKit route-handler export name
    const err = await GET(
      eventFor('state=state-1&code=auth-code', cookie, sets)
    ).catch((caught: unknown) => caught);
    if (!isRedirect(err)) {
      throw new Error('expected a redirect');
    }
    // Not a direct redirect to the client with a code: the code is minted only once the person
    // approves the consent step (`consentAction`, `/oauth/authorize`'s), the same as a
    // password login.
    const location = new URL(err.location, 'https://pbx.example.com');
    expect(location.origin).toBe('https://pbx.example.com');
    expect(location.pathname).toBe('/oauth/authorize');
    expect(location.searchParams.get('code')).toBeNull();
    expect(sets.some(cookieSet => cookieSet.name === CONSENT_COOKIE_NAME)).toBe(
      true
    );
  });
});
