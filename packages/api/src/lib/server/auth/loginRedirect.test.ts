import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AuthCodeStore } from './codes.js';
import { loginRedirect } from './loginRedirect.js';
import type { PendingAuthorize } from './ssoCookie.js';

const NOW = '2026-01-01T00:00:00.000Z';
const ORIGIN = 'https://pbx.example.com';

function pendingAuthorize(state: string | null): PendingAuthorize {
  return {
    clientId: 'outer-client',
    redirectUri: 'https://app.example.com/callback',
    codeChallenge: 'challenge',
    scope: 'openid',
    state
  };
}

describe('loginRedirect', () => {
  it('sends a sign-in without client parameters to the post-login page', () => {
    const codes = new AuthCodeStore(() => Date.parse(NOW));
    expect(loginRedirect(codes, 'user-1', null, ORIGIN)).toBe(
      `${ORIGIN}/auth/done`
    );
  });

  it('issues an authorization code and redirects to the outer redirect_uri', () => {
    const codes = new AuthCodeStore(() => Date.parse(NOW));
    const codeVerifier = 'outer-client-pkce-verifier';
    const authorize = {
      ...pendingAuthorize('outer-state'),
      codeChallenge: createHash('sha256')
        .update(codeVerifier)
        .digest('base64url')
    };
    const location = new URL(loginRedirect(codes, 'user-1', authorize, ORIGIN));
    expect(location.origin + location.pathname).toBe(authorize.redirectUri);
    expect(location.searchParams.get('state')).toBe('outer-state');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    const code = location.searchParams.get('code');
    if (code === null) {
      throw new Error('expected an authorization code');
    }
    expect(
      codes.redeem(
        code,
        codeVerifier,
        authorize.clientId,
        authorize.redirectUri
      )
    ).toEqual({ userId: 'user-1' });
  });

  it('omits state from the response when the request carried none (OAuth 2.1 §4.1.2)', () => {
    const codes = new AuthCodeStore(() => Date.parse(NOW));
    const location = new URL(
      loginRedirect(codes, 'user-1', pendingAuthorize(null), ORIGIN)
    );
    expect(location.searchParams.get('code')).toEqual(expect.any(String));
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(location.searchParams.has('state')).toBe(false);
  });
});
