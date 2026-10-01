import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requiredJwtSecret,
  signAccessToken,
  verifyAccessToken
} from './jwt.js';

const SECRET = 'test-secret';
const NOW_S = 1_700_000_000;
const ACCESS_TOKEN_TTL_S = 900;
const AUDIENCE = 'https://pbx.example.com/mcp';

describe('jwt', () => {
  it('round-trips claims through sign and verify', () => {
    const token = signAccessToken(
      SECRET,
      { sub: 'u1', role: 'admin', cid: 'c1' },
      NOW_S,
      AUDIENCE
    );
    expect(verifyAccessToken(SECRET, token, NOW_S)).toEqual({
      sub: 'u1',
      role: 'admin',
      cid: 'c1'
    });
  });

  it('accepts a null client id, for the direct login flow', () => {
    const token = signAccessToken(
      SECRET,
      { sub: 'u1', role: 'owner', cid: null },
      NOW_S,
      AUDIENCE
    );
    expect(verifyAccessToken(SECRET, token, NOW_S)?.cid).toBeNull();
  });

  it('is valid up to, and expired at, exactly 900 seconds after issuance', () => {
    const token = signAccessToken(
      SECRET,
      { sub: 'u1', role: 'user', cid: null },
      NOW_S,
      AUDIENCE
    );
    expect(
      verifyAccessToken(SECRET, token, NOW_S + ACCESS_TOKEN_TTL_S - 1)
    ).not.toBeNull();
    expect(
      verifyAccessToken(SECRET, token, NOW_S + ACCESS_TOKEN_TTL_S)
    ).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signAccessToken(
      SECRET,
      { sub: 'u1', role: 'user', cid: null },
      NOW_S,
      AUDIENCE
    );
    expect(verifyAccessToken('wrong-secret', token, NOW_S)).toBeNull();
  });

  it('accepts a token for the audience it was issued for, and refuses it for any other', () => {
    const token = signAccessToken(
      SECRET,
      { sub: 'u1', role: 'user', cid: null },
      NOW_S,
      AUDIENCE
    );
    expect(verifyAccessToken(SECRET, token, NOW_S, AUDIENCE)).not.toBeNull();
    expect(
      verifyAccessToken(SECRET, token, NOW_S, 'https://other.example/mcp')
    ).toBeNull();
  });

  it('refuses a token without an audience only where one is required', () => {
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
      'base64url'
    );
    const body = Buffer.from(
      JSON.stringify({
        sub: 'u1',
        role: 'user',
        cid: null,
        iss: '',
        iat: NOW_S,
        exp: NOW_S + ACCESS_TOKEN_TTL_S
      })
    ).toString('base64url');
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');
    const token = `${header}.${body}.${signature}`;
    expect(verifyAccessToken(SECRET, token, NOW_S)).not.toBeNull();
    expect(verifyAccessToken(SECRET, token, NOW_S, AUDIENCE)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyAccessToken(SECRET, 'not-a-jwt', NOW_S)).toBeNull();
  });
});

describe('requiredJwtSecret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads JWT_SECRET, throwing while it is unset', () => {
    vi.stubEnv('JWT_SECRET', SECRET);
    expect(requiredJwtSecret()).toBe(SECRET);
    vi.stubEnv('JWT_SECRET', '');
    expect(() => requiredJwtSecret()).toThrow(
      'JWT_SECRET environment variable is required.'
    );
  });
});
