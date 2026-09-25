import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { makeTestDb } from '../testDb.js';
import { AuthCodeStore } from './codes.js';
import { verifyAccessToken } from './jwt.js';
import { tokenEndpoint, type TokenDeps } from './oauth.js';
import { issueRefresh } from './tokens.js';

// RFC 8707 at the token endpoint (`resource.ts`): the one resource tokens are issued for is this
// stack's MCP server, which every access token names as `aud`.
const ORIGIN = 'https://pbx.example.com';
const MCP_RESOURCE = `${ORIGIN}/mcp`;
const NOW = '2026-01-01T00:00:00.000Z';
const MS_PER_SECOND = 1000;
const NOW_S = Math.floor(Date.parse(NOW) / MS_PER_SECOND);
const SECRET = 'test-secret';
const CLIENT_ID = 'client-1';
const REDIRECT_URI = 'https://client.test/callback';
const VERIFIER = 'a-valid-code-verifier';

async function setup(): Promise<{ deps: TokenDeps; code: string }> {
  const codes = new AuthCodeStore(() => 0);
  const db = await makeTestDb();
  await db
    .insertInto('oauthClients')
    .values({
      clientId: CLIENT_ID,
      name: 'Test Client',
      kind: 'cimd',
      redirectUrisJson: JSON.stringify([REDIRECT_URI]),
      createdAt: NOW,
      lastLoginAt: NOW
    })
    .execute();
  const code = codes.issue({
    userId: 'owner',
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    scope: ''
  });
  const deps: TokenDeps = {
    db,
    jwtSecret: SECRET,
    codes,
    origin: ORIGIN,
    now: () => NOW
  };
  return { deps, code };
}

/** An authorization_code token request, with each of `resources` as one `resource` field. */
function codeRequest(code: string, resources: string[]): Request {
  /* eslint-disable camelcase -- RFC 6749 mandates these snake_case wire fields */
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER
  });
  /* eslint-enable camelcase -- RFC 6749 mandates these snake_case wire fields */
  for (const resource of resources) {
    body.append('resource', resource);
  }
  return new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body });
}

async function accessToken(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

describe('tokenEndpoint (resource, RFC 8707)', () => {
  it('issues a token for this MCP server when the request names it', async () => {
    const { deps, code } = await setup();
    const token = await accessToken(
      await tokenEndpoint(deps, codeRequest(code, [MCP_RESOURCE]))
    );
    expect(
      verifyAccessToken(SECRET, token, NOW_S, MCP_RESOURCE)
    ).not.toBeNull();
  });

  it('issues the same audience to a request without resource, as a REST client sends it', async () => {
    const { deps, code } = await setup();
    const token = await accessToken(
      await tokenEndpoint(deps, codeRequest(code, []))
    );
    expect(
      verifyAccessToken(SECRET, token, NOW_S, MCP_RESOURCE)
    ).not.toBeNull();
    expect(verifyAccessToken(SECRET, token, NOW_S)).not.toBeNull();
  });

  it('accepts an uppercase scheme and host (MCP authorization, "Canonical Server URI")', async () => {
    const { deps, code } = await setup();
    const response = await tokenEndpoint(
      deps,
      codeRequest(code, ['HTTPS://PBX.EXAMPLE.COM/mcp'])
    );
    expect(response.status).toBe(200);
  });

  it('refuses a foreign resource with invalid_target, leaving the code redeemable', async () => {
    const { deps, code } = await setup();
    for (const foreign of [
      'https://other.example/mcp',
      `${ORIGIN}/api/v1`,
      `${MCP_RESOURCE}#frag`,
      'not a uri'
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one code, refused request by request
      const response = await tokenEndpoint(deps, codeRequest(code, [foreign]));
      expect(response.status).toBe(400);
      // eslint-disable-next-line no-await-in-loop -- as above
      expect(await response.json()).toEqual({ error: 'invalid_target' });
    }
    const mixed = await tokenEndpoint(
      deps,
      codeRequest(code, [MCP_RESOURCE, 'https://other.example/mcp'])
    );
    expect(mixed.status).toBe(400);
    await accessToken(await tokenEndpoint(deps, codeRequest(code, [])));
  });

  it('refuses a foreign resource on the refresh grant too', async () => {
    const { deps } = await setup();
    const refresh = await issueRefresh(deps.db, 'owner', CLIENT_ID, NOW);
    /* eslint-disable camelcase -- RFC 6749 mandates these snake_case wire fields */
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh.raw,
      resource: 'https://other.example/mcp'
    });
    /* eslint-enable camelcase -- RFC 6749 mandates these snake_case wire fields */
    const response = await tokenEndpoint(
      deps,
      new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_target' });
  });
});
