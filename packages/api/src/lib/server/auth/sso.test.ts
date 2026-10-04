import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';

import { epochSeconds, nowIso, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { encrypt, keyringFromEnv, type Keyring } from '../secretbox.js';
import {
  discover,
  startLogin,
  type Discovery,
  type SsoConfig
} from './oidc.js';
import { finishLogin } from './sso.js';
import { ssoConfigFromSettings } from './ssoSettings.js';

const NOW = '2026-01-01T00:00:00.000Z';
const NOW_S = epochSeconds(Date.parse(NOW));
const TOKEN_TTL_S = 300;
const ORIGIN = 'https://pbx.example.com';
const CLIENT_ID = 'test-client';
const AUTH_CODE = 'auth-code';
const NONCE = 'test-nonce';
const KEY_ID = 'kid-1';
const SECRETBOX_KEY_VALUE = `0:${Buffer.alloc(32, 7).toString('base64')}`;

function testKeyring(): Keyring {
  return keyringFromEnv({ SECRETBOX_KEY: SECRETBOX_KEY_VALUE });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

type TestClaims = {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  hd?: string;
};

/** A self-signed id_token plus the JWKS its `kid` resolves against (§5.2 "id_token validated
 *  against jwks"). `audience`/`expiresAtS` let a test build a token that fails one specific
 *  `jwtVerify` check without touching the others. */
async function issueIdToken(
  issuer: string,
  claims: TestClaims,
  opts: { audience?: string; expiresAtS?: number } = {}
): Promise<{ idToken: string; jwks: { keys: JWK[] } }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const payload = {
    nonce: NONCE,
    sub: claims.sub,
    email: claims.email,
    email_verified: claims.emailVerified,
    preferred_username: claims.preferredUsername,
    hd: claims.hd
  };
  const idToken = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(issuer)
    .setAudience(opts.audience ?? CLIENT_ID)
    .setIssuedAt(NOW_S)
    .setExpirationTime(opts.expiresAtS ?? NOW_S + TOKEN_TTL_S)
    .sign(privateKey);
  return {
    idToken,
    jwks: { keys: [{ ...publicJwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] }
  };
}

/** `input`, whatever `typeof fetch`'s first argument shape the caller used. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function fetchFor(
  disc: Discovery,
  jwks: unknown,
  idToken: string
): typeof fetch {
  return (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url === disc.tokenEndpoint) {
      return Promise.resolve(jsonResponse({ id_token: idToken }));
    }
    if (url === disc.jwksUri) {
      return Promise.resolve(jsonResponse(jwks));
    }
    throw new Error(`sso test: unexpected fetch ${url}`);
  };
}

function discoveryFor(issuer: string): Discovery {
  return {
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`,
    issuer
  };
}

function oidcConfig(overrides: Partial<SsoConfig> = {}): SsoConfig {
  return {
    provider: 'oidc',
    issuer: 'https://idp.example.com',
    clientId: CLIENT_ID,
    clientSecret: null,
    tenantId: null,
    allowedDomain: null,
    label: 'Test IdP',
    ...overrides
  };
}

async function insertUser(
  db: Db,
  fields: { id: string; email: string; ssoSubject?: string | null }
): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: fields.id,
      name: fields.id,
      email: fields.email,
      ssoSubject: fields.ssoSubject ?? null,
      createdAt: nowIso()
    })
    .execute();
}

describe('finishLogin', () => {
  it('binds sso_subject on the first login matching by e-mail', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'alice', email: 'alice@example.com' });
    const disc = discoveryFor(oidcConfig().issuer);
    const { idToken, jwks } = await issueIdToken(disc.issuer, {
      sub: 'sub-1',
      email: 'alice@example.com',
      emailVerified: true
    });
    const result = await finishLogin(
      db,
      oidcConfig(),
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: true, userId: 'alice' });
    const row = await db
      .selectFrom('users')
      .select('ssoSubject')
      .where('id', '=', 'alice')
      .executeTakeFirstOrThrow();
    expect(row.ssoSubject).toBe('sub-1');
  });

  it('matches a bound user by sub after their e-mail changes', async () => {
    const db = await makeTestDb();
    await insertUser(db, {
      id: 'alice',
      email: 'alice@example.com',
      ssoSubject: 'sub-1'
    });
    await db
      .updateTable('users')
      .set({ email: 'alice.new@example.com' })
      .where('id', '=', 'alice')
      .execute();
    const disc = discoveryFor(oidcConfig().issuer);
    const { idToken, jwks } = await issueIdToken(disc.issuer, {
      sub: 'sub-1',
      email: 'alice@example.com',
      emailVerified: true
    });
    const result = await finishLogin(
      db,
      oidcConfig(),
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: true, userId: 'alice' });
  });

  it('refuses a token whose sub is unknown but whose e-mail is already bound', async () => {
    const db = await makeTestDb();
    await insertUser(db, {
      id: 'alice',
      email: 'alice@example.com',
      ssoSubject: 'sub-1'
    });
    const disc = discoveryFor(oidcConfig().issuer);
    const { idToken, jwks } = await issueIdToken(disc.issuer, {
      sub: 'sub-2',
      email: 'alice@example.com',
      emailVerified: true
    });
    const result = await finishLogin(
      db,
      oidcConfig(),
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: false, reason: 'subMismatch' });
  });

  it('refuses a google token with an unverified e-mail', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'alice', email: 'alice@example.com' });
    const cfg = oidcConfig({
      provider: 'google',
      issuer: 'https://accounts.google.com'
    });
    const disc = discoveryFor(cfg.issuer);
    const { idToken, jwks } = await issueIdToken(disc.issuer, {
      sub: 'sub-1',
      email: 'alice@example.com',
      emailVerified: false
    });
    const result = await finishLogin(
      db,
      cfg,
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: false, reason: 'unverifiedEmail' });
  });

  it('refuses an e-mail domain outside settings.sso_allowed_domain', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'bob', email: 'bob@other.example.com' });
    const cfg = oidcConfig({ allowedDomain: 'allowed.example.com' });
    const disc = discoveryFor(cfg.issuer);
    const { idToken, jwks } = await issueIdToken(disc.issuer, {
      sub: 'sub-1',
      email: 'bob@other.example.com',
      emailVerified: true
    });
    const result = await finishLogin(
      db,
      cfg,
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: false, reason: 'domain' });
  });

  /** `finishLogin` for an id_token carrying `claims`, issued by `cfg`'s issuer. */
  async function loginWith(
    db: Db,
    cfg: SsoConfig,
    claims: TestClaims
  ): Promise<Awaited<ReturnType<typeof finishLogin>>> {
    const disc = discoveryFor(cfg.issuer);
    const { idToken, jwks } = await issueIdToken(disc.issuer, claims);
    return finishLogin(
      db,
      cfg,
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
  }

  it('matches a bound user by sub alone, with no e-mail in the token (§5.2)', async () => {
    const db = await makeTestDb();
    await insertUser(db, {
      id: 'alice',
      email: 'alice@example.com',
      ssoSubject: 'sub-1'
    });
    expect(await loginWith(db, oidcConfig(), { sub: 'sub-1' })).toEqual({
      ok: true,
      userId: 'alice'
    });
  });

  it('matches a bound user by sub alone, with an unverified e-mail (§5.2)', async () => {
    const db = await makeTestDb();
    await insertUser(db, {
      id: 'alice',
      email: 'alice@example.com',
      ssoSubject: 'sub-1'
    });
    const result = await loginWith(db, oidcConfig(), {
      sub: 'sub-1',
      email: 'alice.pending@example.com',
      emailVerified: false
    });
    expect(result).toEqual({ ok: true, userId: 'alice' });
  });

  it('refuses a token with no e-mail for a user not yet bound', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'alice', email: 'alice@example.com' });
    expect(await loginWith(db, oidcConfig(), { sub: 'sub-1' })).toEqual({
      ok: false,
      reason: 'noUser'
    });
  });

  const GOOGLE = {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    allowedDomain: 'customer.example'
  } as const;

  it('refuses a private Google account on an allowed company address (no hd)', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'alice', email: 'alice@customer.example' });
    const result = await loginWith(db, oidcConfig(GOOGLE), {
      sub: 'sub-1',
      email: 'alice@customer.example',
      emailVerified: true
    });
    expect(result).toEqual({ ok: false, reason: 'domain' });
  });

  it('refuses a Google account of another workspace on an allowed address', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'alice', email: 'alice@customer.example' });
    const result = await loginWith(db, oidcConfig(GOOGLE), {
      sub: 'sub-1',
      email: 'alice@customer.example',
      emailVerified: true,
      hd: 'other.example'
    });
    expect(result).toEqual({ ok: false, reason: 'domain' });
  });

  it("accepts a Google account of the allowed domain's workspace", async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'alice', email: 'alice@customer.example' });
    const result = await loginWith(db, oidcConfig(GOOGLE), {
      sub: 'sub-1',
      email: 'alice@customer.example',
      emailVerified: true,
      hd: 'Customer.Example'
    });
    expect(result).toEqual({ ok: true, userId: 'alice' });
  });

  it('refuses an id_token issued for another Microsoft tenant', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'carol', email: 'carol@tenant-a.example' });
    const cfg = oidcConfig({
      provider: 'microsoft',
      issuer: 'https://login.microsoftonline.com/tenant-a/v2.0',
      tenantId: 'tenant-a'
    });
    const disc = discoveryFor(cfg.issuer);
    const { idToken, jwks } = await issueIdToken(
      'https://login.microsoftonline.com/tenant-b/v2.0',
      { sub: 'sub-1', preferredUsername: 'carol@tenant-a.example' }
    );
    const result = await finishLogin(
      db,
      cfg,
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: false, reason: 'issuer' });
  });

  it('matches a Microsoft login by preferred_username, with no email_verified claim', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'carol', email: 'carol@tenant-a.example' });
    const cfg = oidcConfig({
      provider: 'microsoft',
      issuer: 'https://login.microsoftonline.com/tenant-a/v2.0',
      tenantId: 'tenant-a'
    });
    const disc = discoveryFor(cfg.issuer);
    const { idToken, jwks } = await issueIdToken(disc.issuer, {
      sub: 'sub-1',
      preferredUsername: 'carol@tenant-a.example'
    });
    const result = await finishLogin(
      db,
      cfg,
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: true, userId: 'carol' });
  });

  it('reports "audience" for an id_token issued for a different client', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'erin', email: 'erin@example.com' });
    const disc = discoveryFor(oidcConfig().issuer);
    const { idToken, jwks } = await issueIdToken(
      disc.issuer,
      { sub: 'sub-1', email: 'erin@example.com', emailVerified: true },
      { audience: 'someone-elses-client' }
    );
    const result = await finishLogin(
      db,
      oidcConfig(),
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: false, reason: 'audience' });
  });

  it('reports "expired" for an id_token past its exp claim', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'frank', email: 'frank@example.com' });
    const disc = discoveryFor(oidcConfig().issuer);
    const { idToken, jwks } = await issueIdToken(
      disc.issuer,
      { sub: 'sub-1', email: 'frank@example.com', emailVerified: true },
      { expiresAtS: NOW_S - 1 }
    );
    const result = await finishLogin(
      db,
      oidcConfig(),
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, jwks, idToken)
    );
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports "signature" for an id_token that does not verify against the JWKS', async () => {
    const db = await makeTestDb();
    await insertUser(db, { id: 'gina', email: 'gina@example.com' });
    const disc = discoveryFor(oidcConfig().issuer);
    const claims = {
      sub: 'sub-1',
      email: 'gina@example.com',
      emailVerified: true
    };
    const { idToken } = await issueIdToken(disc.issuer, claims);
    // A second, unrelated key pair under the same `kid`: `jwtVerify` finds a key to try and fails
    // signature verification against it, rather than the mismatched key `idToken` was signed with.
    const { jwks: mismatchedJwks } = await issueIdToken(disc.issuer, claims);
    const result = await finishLogin(
      db,
      oidcConfig(),
      disc,
      {
        code: AUTH_CODE,
        codeVerifier: NONCE,
        nonce: NONCE,
        origin: ORIGIN,
        now: NOW
      },
      fetchFor(disc, mismatchedJwks, idToken)
    );
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });
});

describe('startLogin', () => {
  it('builds an authorization URL with PKCE S256 and the OIDC scope', () => {
    const cfg = oidcConfig();
    const disc = discoveryFor(cfg.issuer);
    const codeVerifier = 'verifier-1';
    const url = new URL(
      startLogin(cfg, disc, ORIGIN, 'state-1', NONCE, codeVerifier)
    );
    expect(url.origin + url.pathname).toBe(disc.authorizationEndpoint);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/oauth/callback`
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('nonce')).toBe(NONCE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(codeVerifier).digest('base64url')
    );
  });

  it('never puts the PKCE verifier itself on the authorization URL (RFC 7636)', () => {
    const cfg = oidcConfig();
    const disc = discoveryFor(cfg.issuer);
    expect(
      startLogin(cfg, disc, ORIGIN, 'state-2', NONCE, 'verifier-2')
    ).not.toContain('verifier-2');
  });
});

describe('discover', () => {
  it('fetches and caches the discovery document for an hour', async () => {
    const issuer = 'https://idp.example.com';
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(
        jsonResponse({
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          issuer
        })
      );
    }) as typeof fetch;
    const cfg = oidcConfig({ issuer });
    const first = await discover(cfg, fetchImpl);
    const second = await discover(cfg, fetchImpl);
    expect(first).toEqual(second);
    expect(first).toEqual(discoveryFor(issuer));
    expect(calls).toBe(1);
  });

  it('rejects a discovery document declaring another issuer (RFC 8414 §3.3)', async () => {
    const issuer = 'https://idp2.example.com';
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          issuer: 'https://attacker.example.com'
        })
      )) as typeof fetch;
    await expect(discover(oidcConfig({ issuer }), fetchImpl)).rejects.toThrow(
      /issuer/u
    );
  });
});

describe('ssoConfigFromSettings', () => {
  it('returns null while sso_provider is unset', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    expect(await ssoConfigFromSettings(db, testKeyring())).toBeNull();
  });

  it('pins the Microsoft issuer to the configured tenant', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ssoProvider: 'microsoft',
      ssoClientId: 'ms-client',
      ssoTenantId: 'tenant-a'
    });
    const cfg = await ssoConfigFromSettings(db, testKeyring());
    expect(cfg).toEqual({
      provider: 'microsoft',
      issuer: 'https://login.microsoftonline.com/tenant-a/v2.0',
      clientId: 'ms-client',
      clientSecret: null,
      tenantId: 'tenant-a',
      allowedDomain: null,
      label: 'Microsoft'
    });
  });

  it('decrypts a stored SSO client secret', async () => {
    const kr = testKeyring();
    const db = await makeTestDb();
    await seedSettings(db, {
      ssoProvider: 'oidc',
      ssoClientId: 'oidc-client',
      ssoIssuer: 'https://idp.example.com',
      ssoLabel: 'Company IdP',
      ssoClientSecretEnc: encrypt(kr, 'shh')
    });
    const cfg = await ssoConfigFromSettings(db, kr);
    expect(cfg?.clientSecret).toBe('shh');
    expect(cfg?.label).toBe('Company IdP');
  });
});
