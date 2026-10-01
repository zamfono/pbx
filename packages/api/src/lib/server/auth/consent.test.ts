import { randomBytes } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';

import { MS_PER_SECOND } from '@zamfono/shared';

import { encrypt, keyringFromEnv, type Keyring } from '../secretbox.js';
import {
  CONSENT_COOKIE_NAME,
  setConsentCookie,
  unsealConsent
} from './consent.js';

const KEY_BYTE_LENGTH = 32;
const CONSENT_TTL_S = 300;

function testKeyring(): Keyring {
  return keyringFromEnv({
    SECRETBOX_KEY: `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`
  });
}

const pending = {
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

/** Captures what `setConsentCookie` writes: the sealed value and the cookie options. */
function captureCookie(kr: Keyring): {
  value: string;
  options: { maxAge?: number; path?: string };
} {
  const written: {
    value: string;
    options: { maxAge?: number; path?: string };
  } = {
    value: '',
    options: {}
  };
  setConsentCookie(
    {
      cookies: {
        set: (
          name: string,
          value: string,
          options: { maxAge?: number; path?: string }
        ) => {
          expect(name).toBe(CONSENT_COOKIE_NAME);
          written.value = value;
          written.options = options;
        }
      }
    } as unknown as RequestEvent,
    kr,
    pending
  );
  return written;
}

describe('consent cookie', () => {
  it('is sent to the remote-function endpoint an enhanced consent form posts to', () => {
    // SvelteKit submits a remote `form` to `/_app/remote/<id>` when the page's JavaScript runs;
    // a cookie scoped to `/oauth` never reached it, and every browser approval failed.
    const written = captureCookie(testKeyring());
    expect(written.options.path).toBe('/');
  });

  it('unseals a fresh cookie into the pending decision', () => {
    const kr = testKeyring();
    const written = captureCookie(kr);
    expect(written.options.maxAge).toBe(CONSENT_TTL_S);
    expect(unsealConsent(kr, written.value)).toEqual(pending);
  });

  it('refuses a sealed payload past its own expiry, whatever the cookie lifetime', () => {
    const kr = testKeyring();
    const written = captureCookie(kr);
    const expired = Date.now() + (CONSENT_TTL_S + 1) * MS_PER_SECOND;
    expect(unsealConsent(kr, written.value, expired)).toBeNull();
  });

  it('refuses a sealed payload that names no expiry at all', () => {
    const kr = testKeyring();
    const value = encrypt(kr, JSON.stringify(pending)).toString('base64url');
    expect(unsealConsent(kr, value)).toBeNull();
  });

  it('refuses an absent, malformed or foreign-key cookie', () => {
    const kr = testKeyring();
    expect(unsealConsent(kr, undefined)).toBeNull();
    expect(unsealConsent(kr, 'not-a-sealed-value')).toBeNull();
    const written = captureCookie(testKeyring());
    expect(unsealConsent(kr, written.value)).toBeNull();
  });
});
