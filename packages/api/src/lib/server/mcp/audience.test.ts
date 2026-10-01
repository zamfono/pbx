import { describe, expect, it } from 'vitest';

import { MS_PER_SECOND } from '@zamfono/shared';

import { ACCESS_TOKEN_TTL_S, encodeAccessToken } from '../auth/jwt.js';
import { authenticate } from './auth.js';
import { JWT_SECRET, ORIGIN, seededDeps } from './testKit.js';

/** A request to `/mcp` carrying an access token signed for `audience`. */
async function requestFor(audience: string): Promise<Request> {
  const nowS = Math.floor(Date.now() / MS_PER_SECOND);
  const token = await encodeAccessToken(JWT_SECRET, {
    sub: 'owner',
    role: 'owner',
    cid: null,
    iss: ORIGIN,
    aud: audience,
    iat: nowS,
    exp: nowS + ACCESS_TOKEN_TTL_S
  });
  return new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
}

// MCP 2026-07-28 authorization, "Token Handling": "MCP servers MUST validate that access tokens
// were issued specifically for them as the intended audience, according to RFC 8707 Section 2."
describe('MCP token audience', () => {
  it('accepts a token issued for this MCP server', async () => {
    const deps = await seededDeps();
    const authenticated = await authenticate(
      deps,
      await requestFor(`${ORIGIN}/mcp`)
    );
    expect(authenticated?.actor.id).toBe('owner');
  });

  it('refuses a token issued for another resource, even one this server signed', async () => {
    const deps = await seededDeps();
    expect(
      await authenticate(deps, await requestFor('https://other.example/mcp'))
    ).toBeNull();
    expect(await authenticate(deps, await requestFor(ORIGIN))).toBeNull();
  });
});
