import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyAccessToken } from './jwt.js';
import { requiredJwtSecret, signAccessToken } from './jwtSigning.js';

const SECRET = 'test-secret';
const NOW_S = 1_700_000_000;
const ACCESS_TOKEN_TTL_S = 900;
const ORIGIN = 'https://pbx.example.com';
const AUDIENCE = 'https://pbx.example.com/mcp';

/** An HS256 token assembled by hand from `payload`, as RFC 7519 lays one out. */
function handSigned(payload: object, secret = SECRET): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('jwt', () => {
  it('round-trips claims through sign and verify', async () => {
    const token = await signAccessToken(
      SECRET,
      { sub: 'u1', role: 'admin', cid: 'c1' },
      NOW_S,
      ORIGIN
    );
    expect(await verifyAccessToken(SECRET, token, NOW_S)).toEqual({
      sub: 'u1',
      role: 'admin',
      cid: 'c1'
    });
  });

  it('signs exactly the bytes a hand-assembled token of the same claims has', async () => {
    const token = await signAccessToken(
      SECRET,
      { sub: 'u1', role: 'admin', cid: 'c1' },
      NOW_S,
      ORIGIN
    );
    expect(token).toBe(
      handSigned({
        sub: 'u1',
        role: 'admin',
        cid: 'c1',
        iss: ORIGIN,
        aud: AUDIENCE,
        iat: NOW_S,
        exp: NOW_S + ACCESS_TOKEN_TTL_S
      })
    );
  });

  it('accepts a hand-assembled token with the claims every issued token carries', async () => {
    const token = handSigned({
      sub: 'u1',
      role: 'user',
      cid: null,
      iss: ORIGIN,
      aud: AUDIENCE,
      iat: NOW_S,
      exp: NOW_S + ACCESS_TOKEN_TTL_S
    });
    expect(await verifyAccessToken(SECRET, token, NOW_S, AUDIENCE)).toEqual({
      sub: 'u1',
      role: 'user',
      cid: null
    });
  });

  it('accepts a null client id, for the direct login flow', async () => {
    const token = await signAccessToken(
      SECRET,
      { sub: 'u1', role: 'owner', cid: null },
      NOW_S,
      ORIGIN
    );
    expect((await verifyAccessToken(SECRET, token, NOW_S))?.cid).toBeNull();
  });

  it('is valid up to, and expired at, exactly 900 seconds after issuance', async () => {
    const token = await signAccessToken(
      SECRET,
      { sub: 'u1', role: 'user', cid: null },
      NOW_S,
      ORIGIN
    );
    expect(
      await verifyAccessToken(SECRET, token, NOW_S + ACCESS_TOKEN_TTL_S - 1)
    ).not.toBeNull();
    expect(
      await verifyAccessToken(SECRET, token, NOW_S + ACCESS_TOKEN_TTL_S)
    ).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken(
      SECRET,
      { sub: 'u1', role: 'user', cid: null },
      NOW_S,
      ORIGIN
    );
    expect(await verifyAccessToken('wrong-secret', token, NOW_S)).toBeNull();
  });

  it('accepts a token for the audience it was issued for, and refuses it for any other', async () => {
    const token = await signAccessToken(
      SECRET,
      { sub: 'u1', role: 'user', cid: null },
      NOW_S,
      ORIGIN
    );
    expect(
      await verifyAccessToken(SECRET, token, NOW_S, AUDIENCE)
    ).not.toBeNull();
    expect(
      await verifyAccessToken(SECRET, token, NOW_S, 'https://other.example/mcp')
    ).toBeNull();
  });

  it('refuses a token without an audience', async () => {
    const token = handSigned({
      sub: 'u1',
      role: 'user',
      cid: null,
      iss: ORIGIN,
      iat: NOW_S,
      exp: NOW_S + ACCESS_TOKEN_TTL_S
    });
    expect(await verifyAccessToken(SECRET, token, NOW_S)).toBeNull();
    expect(await verifyAccessToken(SECRET, token, NOW_S, AUDIENCE)).toBeNull();
  });

  it('refuses a token whose role is none of the three', async () => {
    const token = handSigned({
      sub: 'u1',
      role: 'root',
      cid: null,
      iss: ORIGIN,
      aud: AUDIENCE,
      iat: NOW_S,
      exp: NOW_S + ACCESS_TOKEN_TTL_S
    });
    expect(await verifyAccessToken(SECRET, token, NOW_S)).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifyAccessToken(SECRET, 'not-a-jwt', NOW_S)).toBeNull();
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
