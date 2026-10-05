import { afterEach, describe, expect, it, vi } from 'vitest';

import { MS_PER_SECOND } from '@zamfono/shared';

import { testKeyring } from '#testing/fixtures.js';
import { cookieJar } from '#testing/requestEvent.js';

import { encrypt } from '../secretbox.js';
import { CONSENT_COOKIE, type PendingConsent } from './consent.js';
import { setSealedCookie, unsealCookie } from './sealedCookie.js';
import { SSO_COOKIE, type PendingLogin } from './ssoCookie.js';

const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');

const consent: PendingConsent = {
  userId: 'user-1',
  clientName: 'Callback Client',
  authorize: {
    clientId: 'client-1',
    redirectUri: 'https://client.example.com/callback',
    codeChallenge: 'challenge-1',
    scope: 'openid',
    state: 'state-1'
  }
};

const login: PendingLogin = {
  state: 'upstream-state',
  nonce: 'nonce',
  codeVerifier: 'verifier',
  authorizeParams: null
};

afterEach(() => {
  vi.useRealTimers();
});

describe('sealed cookies', () => {
  it('sets each cookie HttpOnly, Secure and SameSite=Lax, on its own path and lifetime', () => {
    const kr = testKeyring();
    const jar = cookieJar();
    setSealedCookie(jar, kr, SSO_COOKIE, login);
    setSealedCookie(jar, kr, CONSENT_COOKIE, consent);
    const flags = { httpOnly: true, secure: true, sameSite: 'lax' };
    expect(jar.written.get('zamfono_sso')?.options).toEqual({
      ...flags,
      path: '/oauth',
      maxAge: 600
    });
    // SvelteKit submits a remote `form` to `/_app/remote/<id>` when the page's JavaScript runs;
    // a consent cookie scoped to `/oauth` would never reach it.
    expect(jar.written.get('zamfono_consent')?.options).toEqual({
      ...flags,
      path: '/',
      maxAge: 300
    });
  });

  it('unseals each payload until its sealed expiry, and not from then on', () => {
    vi.useFakeTimers({ now: NOW_MS });
    const kr = testKeyring();
    const jar = cookieJar();
    setSealedCookie(jar, kr, SSO_COOKIE, login);
    setSealedCookie(jar, kr, CONSENT_COOKIE, consent);
    vi.setSystemTime(NOW_MS + 300 * MS_PER_SECOND - 1);
    expect(unsealCookie(jar, kr, SSO_COOKIE)).toEqual(login);
    expect(unsealCookie(jar, kr, CONSENT_COOKIE)).toEqual(consent);
    // A replayed cookie value carries no `Max-Age`: only the sealed expiry bounds it.
    vi.setSystemTime(NOW_MS + 300 * MS_PER_SECOND);
    expect(unsealCookie(jar, kr, CONSENT_COOKIE)).toBeNull();
    vi.setSystemTime(NOW_MS + 600 * MS_PER_SECOND - 1);
    expect(unsealCookie(jar, kr, SSO_COOKIE)).toEqual(login);
    vi.setSystemTime(NOW_MS + 600 * MS_PER_SECOND);
    expect(unsealCookie(jar, kr, SSO_COOKIE)).toBeNull();
  });

  it('unseals a value sealed as `{ ...payload, expiresAtS }`, the layout a cookie in flight has', () => {
    vi.useFakeTimers({ now: NOW_MS });
    const kr = testKeyring();
    const jar = cookieJar();
    const expiresAtS = NOW_MS / MS_PER_SECOND + 600;
    const value = encrypt(
      kr,
      'cookie.zamfono_sso',
      JSON.stringify({ ...login, expiresAtS })
    );
    jar.set('zamfono_sso', value.toString('base64url'), { path: '/oauth' });
    expect(unsealCookie(jar, kr, SSO_COOKIE)).toEqual(login);
  });

  it('refuses a sealed payload that names no expiry at all', () => {
    const kr = testKeyring();
    const jar = cookieJar();
    const value = encrypt(
      kr,
      'cookie.zamfono_consent',
      JSON.stringify(consent)
    ).toString('base64url');
    jar.set('zamfono_consent', value, { path: '/' });
    expect(unsealCookie(jar, kr, CONSENT_COOKIE)).toBeNull();
  });

  it('refuses a blob the keyring encrypted for a stored secret, whatever its plaintext', () => {
    vi.useFakeTimers({ now: NOW_MS });
    const kr = testKeyring();
    // An admin chooses a webhook secret's plaintext (`webhooks.create` stores it encrypted)
    // and reads the blob back from a backup run to a target of their own: the blob must not
    // pass as a consent decision naming another user.
    const secret = JSON.stringify({
      ...consent,
      userId: 'owner-1',
      expiresAtS: NOW_MS / MS_PER_SECOND + 86_400
    });
    const jar = cookieJar();
    jar.set(
      'zamfono_consent',
      encrypt(kr, 'webhooks.secretEnc', secret).toString('base64url'),
      {
        path: '/'
      }
    );
    expect(unsealCookie(jar, kr, CONSENT_COOKIE)).toBeNull();
  });

  it('refuses an absent, malformed, foreign-key or other-shaped cookie', () => {
    const kr = testKeyring();
    expect(unsealCookie(cookieJar(), kr, CONSENT_COOKIE)).toBeNull();
    const malformed = cookieJar();
    malformed.set('zamfono_consent', 'not-a-sealed-value', { path: '/' });
    expect(unsealCookie(malformed, kr, CONSENT_COOKIE)).toBeNull();
    const foreign = cookieJar();
    setSealedCookie(foreign, testKeyring(), CONSENT_COOKIE, consent);
    expect(unsealCookie(foreign, kr, CONSENT_COOKIE)).toBeNull();
    const swapped = cookieJar();
    setSealedCookie(swapped, kr, SSO_COOKIE, login);
    swapped.set('zamfono_consent', swapped.get('zamfono_sso') ?? '', {
      path: '/'
    });
    expect(unsealCookie(swapped, kr, CONSENT_COOKIE)).toBeNull();
  });
});
