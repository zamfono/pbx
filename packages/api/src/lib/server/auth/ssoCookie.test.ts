import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { encrypt, keyringFromEnv } from '../secretbox.js';
import {
  sealedPendingLoginValue,
  sealPendingLogin,
  unsealPendingLogin,
  type PendingLogin
} from './ssoCookie.js';

const KEY_BYTE_LENGTH = 32;
const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
const TTL_MS = 600_000;

process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

const PENDING: PendingLogin = {
  state: 'upstream-state',
  nonce: 'nonce',
  codeVerifier: 'verifier',
  authorizeParams: null
};

describe('the zamfono_sso cookie', () => {
  it('unseals a pending login until its sealed expiry', () => {
    const value = sealedPendingLoginValue(PENDING, NOW_MS);
    expect(unsealPendingLogin(value, NOW_MS + TTL_MS - 1)).toEqual(PENDING);
  });

  it('refuses a pending login past its sealed expiry, whatever the cookie lifetime', () => {
    // A replayed cookie value carries no `Max-Age`: only the sealed expiry bounds it.
    const value = sealedPendingLoginValue(PENDING, NOW_MS);
    expect(unsealPendingLogin(value, NOW_MS + TTL_MS)).toBeNull();
  });

  it('seals the same expiry into the Set-Cookie form', () => {
    const cookie = sealPendingLogin(PENDING, NOW_MS);
    expect(cookie).toContain('Max-Age=600');
    const value = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
    expect(unsealPendingLogin(value, NOW_MS + TTL_MS)).toBeNull();
  });

  it('refuses a sealed pending login that names no expiry at all', () => {
    const kr = keyringFromEnv(process.env);
    const value = encrypt(kr, JSON.stringify(PENDING)).toString('base64url');
    expect(unsealPendingLogin(value, NOW_MS)).toBeNull();
  });
});
