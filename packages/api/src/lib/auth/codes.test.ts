import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AuthCodeStore } from './codes.js';

const CODE_TTL_MS = 60_000;

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('AuthCodeStore', () => {
  it('redeems a freshly issued code with the matching S256 verifier', () => {
    const now = 0;
    const store = new AuthCodeStore(() => now);
    const verifier = 'a-code-verifier';
    const code = store.issue({
      userId: 'u1',
      clientId: 'c1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: challengeFor(verifier),
      scope: ''
    });
    expect(
      store.redeem(code, verifier, 'c1', 'https://client.test/callback')
    ).toEqual({ userId: 'u1' });
  });

  it('is single-use: a second redemption of the same code fails', () => {
    const now = 0;
    const store = new AuthCodeStore(() => now);
    const verifier = 'a-code-verifier';
    const code = store.issue({
      userId: 'u1',
      clientId: 'c1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: challengeFor(verifier),
      scope: ''
    });
    store.redeem(code, verifier, 'c1', 'https://client.test/callback');
    expect(
      store.redeem(code, verifier, 'c1', 'https://client.test/callback')
    ).toBeNull();
  });

  it('refuses a wrong PKCE verifier', () => {
    const now = 0;
    const store = new AuthCodeStore(() => now);
    const code = store.issue({
      userId: 'u1',
      clientId: 'c1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: challengeFor('the-real-verifier'),
      scope: ''
    });
    expect(
      store.redeem(
        code,
        'a-wrong-verifier',
        'c1',
        'https://client.test/callback'
      )
    ).toBeNull();
  });

  it('refuses a code once 60 seconds have passed', () => {
    let now = 0;
    const store = new AuthCodeStore(() => now);
    const verifier = 'a-code-verifier';
    const code = store.issue({
      userId: 'u1',
      clientId: 'c1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: challengeFor(verifier),
      scope: ''
    });
    now = CODE_TTL_MS;
    expect(
      store.redeem(code, verifier, 'c1', 'https://client.test/callback')
    ).toBeNull();
  });

  it('refuses redemption from a different client or redirect uri', () => {
    const now = 0;
    const store = new AuthCodeStore(() => now);
    const verifier = 'a-code-verifier';
    const code = store.issue({
      userId: 'u1',
      clientId: 'c1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: challengeFor(verifier),
      scope: ''
    });
    expect(
      store.redeem(
        code,
        verifier,
        'other-client',
        'https://client.test/callback'
      )
    ).toBeNull();
  });

  // OAuth 2.1 §10.2: the token request's `redirect_uri` is enforced as RFC 6749 §4.1.3 does,
  // required only when the authorization request included one.
  it('redeems without a redirect_uri only a code whose authorization request sent none', () => {
    const now = 0;
    const store = new AuthCodeStore(() => now);
    const verifier = 'a-code-verifier';
    const issued = {
      userId: 'u1',
      clientId: 'c1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: challengeFor(verifier),
      scope: ''
    };
    const sent = store.issue(issued);
    expect(store.redeem(sent, verifier, 'c1', null)).toBeNull();
    const omitted = store.issue({ ...issued, redirectUriDefaulted: true });
    expect(store.redeem(omitted, verifier, 'c1', null)).toEqual({
      userId: 'u1'
    });
    const omittedThenSent = store.issue({
      ...issued,
      redirectUriDefaulted: true
    });
    expect(
      store.redeem(omittedThenSent, verifier, 'c1', 'https://other.test/cb')
    ).toBeNull();
  });
});
