import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import process from 'node:process';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import * as privateEnv from '$app/env/private';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';
import {
  migrateForTest,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import { encodeMetadataClientId } from '#lib/server/auth/clients.js';
import { authCodeStore } from '#lib/server/auth/codes.js';
import { CONSENT_COOKIE } from '#lib/server/auth/consent.js';
import { hashPassword, verifyPassword } from '#lib/server/auth/password.js';
import { setSealedCookie } from '#lib/server/auth/sealedCookie.js';
import { tokenEndpoint } from '#lib/server/auth/tokenEndpoint.js';
import { getDb } from '#lib/server/db.js';
import { accountLockedUntil } from '#lib/server/ops/users/_accountLock.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { fakeHttpsRequest } from '#testing/httpsFake.js';
import { cookieJar, requestEvent } from '#testing/requestEvent.js';

import { load } from './+page.server.js';
import {
  approveConsentSubmit,
  denyConsentSubmit,
  type ConsentShown
} from './consentSubmit.js';
import { loginSubmit, type LoginResult } from './loginSubmit.js';

// A metadata document's host resolves to a public documentation-range address, and its request
// is answered in process (`#testing/httpsFake.js`), with no network.
vi.mock('node:dns', async importOriginal => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: (
    _host: string,
    _options: unknown,
    callback: (err: null, addresses: object[]) => void
  ) => {
    callback(null, [{ address: '203.0.113.10', family: 4 }]);
  }
}));
vi.mock('node:https', async importOriginal => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: vi.fn()
}));

// The real Argon2id check, observed: a test counts the attempts that reached a stored hash.
vi.mock('#lib/server/auth/password.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/auth/password.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const KEY_BYTE_LENGTH = 32;
const FQDN = 'pbx.example.com';
const ORIGIN = `https://${FQDN}`;
const PASSWORD = 'correct horse battery staple';

process.env.DB_FILE = ':memory:';
process.env.FQDN = FQDN;
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

/** A dynamically-registered client id (§5.2), so tests never hit the network for a CIMD fetch. */
function testClientId(redirectUri: string): string {
  return encodeMetadataClientId(keyringFromEnv(privateEnv), {
    name: 'Test Client',
    redirectUris: [redirectUri],
    applicationType: 'web'
  });
}

/** The request the consent step `result` renders carries in its form's hidden fields. */
function consentShown(result: LoginResult): ConsentShown {
  if (!('needsConsent' in result)) {
    throw new Error('expected the consent step');
  }
  return { client_id: result.clientId, code_challenge: result.codeChallenge };
}

/** An owner `email` signing in with `PASSWORD`. */
async function seedOwner(db: Db, email: string): Promise<void> {
  await seedUser(db, {
    name: 'Anna',
    email,
    role: 'owner',
    passwordHash: await hashPassword(PASSWORD)
  });
}

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await seedOwner(db, 'owner@example.com');
  await seedSettings(db, { companyName: 'Acme', language: 'en' });
});

/** A `RequestEvent` for a submission to `/oauth/authorize`, sharing `cookies` (default: a fresh
 *  jar) so the login step's `Set-Cookie` is visible to a later approve/deny in the same test, the
 *  same way a browser carries the `zamfono_consent` cookie between the two requests. */
function eventFor(cookies = cookieJar()): RequestEvent {
  return requestEvent(`${ORIGIN}/oauth/authorize`, {
    cookies,
    clientAddress: '203.0.113.1'
  });
}

/** The login form's payload, as the `form` schema hands it to `loginSubmit`. */
function loginPayload(
  email: string,
  password: string,
  authorize: Record<string, string> = {}
): Parameters<typeof loginSubmit>[1] {
  return {
    ...authorize,
    email,
    _password: password,
    action: 'password'
  };
}

describe('the login step', () => {
  it('increments the lock counter and returns 400 with a generic message on a wrong password', async () => {
    const email = 'lockout-1@example.com';
    const db = getDb();
    await seedOwner(db, email);
    const result = await loginSubmit(
      eventFor(),
      loginPayload(email, 'not the password')
    );
    expect(result).toEqual({
      message: expect.any(String) as string,
      email
    });
    // The counter actually advanced: four more wrong attempts reach the five-attempt lock
    // (§5.5), which a counter that never moved past this first attempt could not reach.
    const remainingAttempts = 4;
    for (let attempt = 0; attempt < remainingAttempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts are the point of this loop
      await loginSubmit(eventFor(), loginPayload(email, 'still wrong'));
    }
    const locked = await loginSubmit(eventFor(), loginPayload(email, PASSWORD));
    expect(locked).toEqual({
      message: expect.any(String) as string,
      email
    });
  });

  it('answers a locked account exactly like a wrong password (§5.5)', async () => {
    const email = 'lockout-2@example.com';
    const db = getDb();
    await seedOwner(db, email);
    const attemptsToLock = 5;
    for (let attempt = 0; attempt < attemptsToLock; attempt += 1) {
      // Each attempt must land before the next, to actually cross the lock threshold
      // sequentially.
      // eslint-disable-next-line no-await-in-loop -- sequential attempts are the point of this loop
      await loginSubmit(eventFor(), loginPayload(email, 'wrong'));
    }
    // Now locked: even the *correct* password is refused, with the same generic message.
    const locked = await loginSubmit(eventFor(), loginPayload(email, PASSWORD));
    expect(locked).toEqual({
      message: expect.any(String) as string,
      email
    });
  });

  it('renders the consent step on a correct password, then redirects with code, state and iss once approved', async () => {
    const email = 'success-1@example.com';
    const db = getDb();
    await seedOwner(db, email);
    const cookies = cookieJar();
    const authorize = {
      client_id: testClientId('https://client.example.com/callback'),
      redirect_uri: 'https://client.example.com/callback',
      state: 'state-1',
      code_challenge: 'challenge-1',
      scope: 'openid'
    };
    const loginResult = await loginSubmit(
      eventFor(cookies),
      loginPayload(email, PASSWORD, authorize)
    );
    expect(loginResult).toEqual({
      needsConsent: true,
      clientName: 'Test Client',
      redirectUri: 'https://client.example.com/callback',
      clientId: authorize.client_id,
      codeChallenge: 'challenge-1'
    });
    // The login step authenticates and seals a consent decision; it never redirects with a code
    // on its own (§5.2 "Authentication pages": login → consent step → 302).
    const err = await approveConsentSubmit(
      eventFor(cookies),
      consentShown(loginResult)
    ).catch((caught: unknown) => caught);
    if (!isRedirect(err)) {
      throw new Error('expected a redirect');
    }
    expect(err.status).toBe(302);
    const location = new URL(err.location);
    expect(location.origin).toBe('https://client.example.com');
    expect(location.searchParams.get('state')).toBe('state-1');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(location.searchParams.get('code')).toEqual(expect.any(String));
  });

  it('accepts a request without state and answers without one (OAuth 2.1 §4.1.1: optional)', async () => {
    const email = 'no-state@example.com';
    const db = getDb();
    await seedOwner(db, email);
    const cookies = cookieJar();
    const loginResult = await loginSubmit(
      eventFor(cookies),
      loginPayload(email, PASSWORD, {
        client_id: testClientId('https://client.example.com/callback'),
        redirect_uri: 'https://client.example.com/callback',
        code_challenge: 'challenge-no-state',
        scope: 'openid'
      })
    );
    expect(loginResult).toMatchObject({ needsConsent: true });
    const err = await approveConsentSubmit(
      eventFor(cookies),
      consentShown(loginResult)
    ).catch((caught: unknown) => caught);
    if (!isRedirect(err)) {
      throw new Error('expected a redirect');
    }
    const location = new URL(err.location);
    expect(location.searchParams.get('code')).toEqual(expect.any(String));
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(location.searchParams.has('state')).toBe(false);
  });

  it('mints a code redeemable without redirect_uri for a request that sent none (OAuth 2.1 §2.3.2, §10.2)', async () => {
    const email = 'no-redirect@example.com';
    const db = getDb();
    await seedOwner(db, email);
    const cookies = cookieJar();
    const clientId = testClientId('https://client.example.com/callback');
    const verifier = 'verifier-no-redirect-uri';
    const loginResult = await loginSubmit(
      eventFor(cookies),
      loginPayload(email, PASSWORD, {
        client_id: clientId,
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        scope: 'openid'
      })
    );
    const err = await approveConsentSubmit(
      eventFor(cookies),
      consentShown(loginResult)
    ).catch((caught: unknown) => caught);
    if (!isRedirect(err)) {
      throw new Error('expected a redirect');
    }
    const location = new URL(err.location);
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://client.example.com/callback'
    );
    const response = await tokenEndpoint(
      {
        db,
        jwtSecret: 'test-secret',
        codes: authCodeStore,
        origin: ORIGIN,
        now: nowIso
      },
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: location.searchParams.get('code') ?? '',
          client_id: clientId,
          code_verifier: verifier
        })
      })
    );
    expect(response.status).toBe(200);
  });

  it('mints no code and redirects with error=access_denied when consent is denied', async () => {
    const email = 'success-3@example.com';
    const db = getDb();
    await seedOwner(db, email);
    const cookies = cookieJar();
    const loginResult = await loginSubmit(
      eventFor(cookies),
      loginPayload(email, PASSWORD, {
        client_id: testClientId('https://client.example.com/callback'),
        redirect_uri: 'https://client.example.com/callback',
        state: 'state-3',
        code_challenge: 'challenge-3',
        scope: 'openid'
      })
    );
    const err = await denyConsentSubmit(
      eventFor(cookies),
      consentShown(loginResult)
    ).catch((caught: unknown) => caught);
    if (!isRedirect(err)) {
      throw new Error('expected a redirect');
    }
    const location = new URL(err.location);
    expect(location.origin).toBe('https://client.example.com');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-3');
    // RFC 9207: an error response names its issuer just as a success does (§5.2).
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('locks the account for a case variant of an e-mail already locked (§5.5, §11.2 NOCASE)', async () => {
    const email = 'CaseLock@example.com';
    const db = getDb();
    await seedOwner(db, email.toLowerCase());
    const attemptsToLock = 5;
    for (let attempt = 0; attempt < attemptsToLock; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts are the point of this loop
      await loginSubmit(eventFor(), loginPayload(email, 'wrong'));
    }
    // The correct password, presented with a differently-cased e-mail, still finds the account
    // locked: the limiter key must be the same normalized form `users.email`'s NOCASE collation
    // matches on, or an attacker gets a fresh 5-attempt budget per case variant.
    const locked = await loginSubmit(
      eventFor(),
      loginPayload(email.toLowerCase(), PASSWORD)
    );
    expect(locked).toEqual({
      message: expect.any(String) as string,
      email: email.toLowerCase()
    });
  });

  it('checks at most five of six parallel wrong passwords against the account (§5.5)', async () => {
    const email = 'parallel@example.com';
    await seedOwner(getDb(), email);
    vi.mocked(verifyPassword).mockClear();
    const parallelAttempts = 6;
    await Promise.all(
      Array.from({ length: parallelAttempts }, () =>
        loginSubmit(eventFor(), loginPayload(email, 'wrong'))
      )
    );
    const checkedAgainstHash = vi
      .mocked(verifyPassword)
      .mock.calls.filter(([hash]) => hash !== null);
    expect(checkedAgainstHash.length).toBeLessThanOrEqual(5);
  });

  it('shows the lock on the user record of an e-mail stored in mixed case (§5.5)', async () => {
    const email = 'Mixed.Case@Example.com';
    const db = getDb();
    await seedOwner(db, email);
    const attemptsToLock = 5;
    for (let attempt = 0; attempt < attemptsToLock; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts are the point of this loop
      await loginSubmit(eventFor(), loginPayload(email, 'wrong'));
    }
    // `toUserOut` reads the lock with the e-mail exactly as `users.create` stored it.
    expect(accountLockedUntil(email)).not.toBeNull();
  });

  it('renders the error page with status 400, without redirecting, for a rejected redirect_uri', async () => {
    const email = 'success-2@example.com';
    const db = getDb();
    await seedOwner(db, email);
    const err = await loginSubmit(
      eventFor(),
      loginPayload(email, PASSWORD, {
        client_id: testClientId('https://client.example.com/callback'),
        redirect_uri: 'https://not-registered.example.com/callback',
        state: 'state-2',
        code_challenge: 'challenge-2',
        scope: 'openid'
      })
    ).catch((caught: unknown) => caught);
    expect(isRedirect(err)).toBe(false);
    if (!isHttpError(err)) {
      throw new Error('expected an HttpError');
    }
    expect(err.status).toBe(400);
  });
});

describe('GET /oauth/authorize (load)', () => {
  it('renders a bare login for a request with no client_id', async () => {
    const data = await load(
      requestEvent(new URL(`${ORIGIN}/oauth/authorize`), {
        cookies: cookieJar()
      })
    );
    expect(data.authorize).toBeNull();
    expect(data.consent).toBeNull();
  });

  it('renders the consent step for a pending `zamfono_consent` cookie, the same one the SSO callback sets', async () => {
    const cookies = cookieJar();
    const kr = keyringFromEnv(privateEnv);
    setSealedCookie(cookies, kr, CONSENT_COOKIE, {
      userId: 'user-1',
      clientName: 'Callback Client',
      authorize: {
        clientId: 'client-1',
        redirectUri: 'https://client.example.com/callback',
        codeChallenge: 'challenge-1',
        scope: 'openid',
        state: 'state-1'
      }
    });
    const data = await load(
      requestEvent(new URL(`${ORIGIN}/oauth/authorize`), { cookies })
    );
    expect(data.authorize).toBeNull();
    expect(data.consent).toEqual({
      clientName: 'Callback Client',
      redirectUri: 'https://client.example.com/callback',
      clientId: 'client-1',
      codeChallenge: 'challenge-1'
    });
  });

  it('renders the login form for a request without state (OAuth 2.1 §4.1.1: optional)', async () => {
    const url = new URL(`${ORIGIN}/oauth/authorize`);
    url.searchParams.set(
      'client_id',
      testClientId('https://client.example.com/callback')
    );
    url.searchParams.set('redirect_uri', 'https://client.example.com/callback');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', 'challenge-1');
    const data = await load(requestEvent(url, { cookies: cookieJar() }));
    expect(data.authorize).toMatchObject({ state: null });
  });

  /** The status of `load`'s thrown error page for `url`, failing the test on a redirect. */
  async function loadErrorStatus(url: URL): Promise<number> {
    const err = await load(requestEvent(url, { cookies: cookieJar() })).catch(
      (caught: unknown) => caught
    );
    expect(isRedirect(err)).toBe(false);
    if (!isHttpError(err)) {
      throw new Error('expected an HttpError');
    }
    return err.status;
  }

  function requestUrl(overrides: Record<string, string | null>): URL {
    const url = new URL(`${ORIGIN}/oauth/authorize`);
    url.searchParams.set(
      'client_id',
      testClientId('https://client.example.com/callback')
    );
    url.searchParams.set('redirect_uri', 'https://client.example.com/callback');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', 'state-1');
    url.searchParams.set('code_challenge', 'challenge-1');
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) {
        url.searchParams.delete(name);
      } else {
        url.searchParams.set(name, value);
      }
    }
    return url;
  }

  // RFC 9700 §4.11.2: before the person has acted, no request redirects to the client, so
  // `/oauth/authorize` serves as no open redirector, even for a statelessly registered client.
  it.each([
    ['an unsupported response_type', { response_type: 'token' }],
    ['a request without response_type', { response_type: null }],
    ['a foreign resource', { resource: 'https://other.example/mcp' }],
    [
      'an unsupported code_challenge_method',
      { code_challenge_method: 'plain' }
    ],
    ['a request without a PKCE challenge', { code_challenge: null }]
  ])(
    'renders the error page with status 400, without redirecting, for %s',
    async (_label, overrides: Record<string, string | null>) => {
      expect(await loadErrorStatus(requestUrl(overrides))).toBe(400);
    }
  );

  it("proceeds to the login form for this stack's own MCP resource", async () => {
    const data = await load(
      requestEvent(requestUrl({ resource: `${ORIGIN}/mcp` }), {
        cookies: cookieJar()
      })
    );
    expect(data.authorize).toMatchObject({
      redirectUri: 'https://client.example.com/callback'
    });
  });

  it('resumes a request without redirect_uri at the single registered one (OAuth 2.1 §2.3.2)', async () => {
    const data = await load(
      requestEvent(requestUrl({ redirect_uri: null }), { cookies: cookieJar() })
    );
    expect(data.authorize).toMatchObject({
      redirectUri: 'https://client.example.com/callback',
      redirectUriDefaulted: true
    });
  });

  it('refuses a request without redirect_uri, without redirecting, from a client with several', async () => {
    const clientId = encodeMetadataClientId(keyringFromEnv(privateEnv), {
      name: 'Two Callbacks',
      redirectUris: [
        'https://client.example.com/callback',
        'https://client.example.com/other'
      ],
      applicationType: 'web'
    });
    const err = await load(
      requestEvent(requestUrl({ client_id: clientId, redirect_uri: null }), {
        cookies: cookieJar()
      })
    ).catch((caught: unknown) => caught);
    expect(isRedirect(err)).toBe(false);
    if (!isHttpError(err)) {
      throw new Error('expected an HttpError');
    }
    expect(err.status).toBe(400);
  });

  it('never redirects to an unregistered redirect_uri, whatever else is wrong', async () => {
    const err = await load(
      requestEvent(
        requestUrl({
          redirect_uri: 'https://not-registered.example.com/callback',
          response_type: 'token'
        }),
        { cookies: cookieJar() }
      )
    ).catch((caught: unknown) => caught);
    expect(isRedirect(err)).toBe(false);
    if (!isHttpError(err)) {
      throw new Error('expected an HttpError');
    }
    expect(err.status).toBe(400);
  });
});

describe("Claude Code's sign-in on a random loopback port (RFC 8252 §7.3)", () => {
  const CLAUDE_CODE_CLIENT_ID =
    'https://claude.ai/oauth/claude-code-client-metadata';
  const REDIRECT_URI = 'http://localhost:49536/callback';
  /** Serves Claude Code's metadata document as it did on 2026-10-01: no `application_type`, and
   *  redirect URIs without a port. */
  function serveClaudeCodeDocument(): void {
    vi.mocked(request).mockImplementation(
      fakeHttpsRequest(() => ({
        body: JSON.stringify({
          client_id: CLAUDE_CODE_CLIENT_ID,
          client_name: 'Claude Code',
          client_uri: 'https://claude.ai',
          redirect_uris: [
            'http://localhost/callback',
            'http://127.0.0.1/callback'
          ],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        }),
        headers: { 'content-type': 'application/json' }
      }))
    );
  }

  /** Logs in and approves for Claude Code at {@link REDIRECT_URI}; the code it is redirected with. */
  async function codeFor(email: string, verifier: string): Promise<string> {
    serveClaudeCodeDocument();
    await seedOwner(getDb(), email);
    const cookies = cookieJar();
    const loginResult = await loginSubmit(
      eventFor(cookies),
      loginPayload(email, PASSWORD, {
        client_id: CLAUDE_CODE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        state: 'state-claude-code',
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        scope: 'openid'
      })
    );
    expect(loginResult).toEqual({
      needsConsent: true,
      clientName: 'Claude Code',
      redirectUri: REDIRECT_URI,
      clientId: CLAUDE_CODE_CLIENT_ID,
      codeChallenge: expect.any(String) as string
    });
    const err = await approveConsentSubmit(
      eventFor(cookies),
      consentShown(loginResult)
    ).catch((caught: unknown) => caught);
    if (!isRedirect(err)) {
      throw new Error('expected a redirect');
    }
    const location = new URL(err.location);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    return location.searchParams.get('code') ?? '';
  }

  function redeem(
    code: string,
    verifier: string,
    redirectUri: string
  ): Promise<Response> {
    return tokenEndpoint(
      {
        db: getDb(),
        jwtSecret: 'test-secret',
        codes: authCodeStore,
        origin: ORIGIN,
        now: nowIso
      },
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: CLAUDE_CODE_CLIENT_ID,
          code_verifier: verifier
        })
      })
    );
  }

  it('authorizes the port-bearing redirect and exchanges its code for tokens', async () => {
    const verifier = 'verifier-claude-code';
    const code = await codeFor('claude-code@example.com', verifier);
    const response = await redeem(code, verifier, REDIRECT_URI);
    expect(response.status).toBe(200);
  });

  it('refuses the code at the registered port-less URI: the exchange matches the request exactly (OAuth 2.1 §4.1.3)', async () => {
    const verifier = 'verifier-claude-code-portless';
    const code = await codeFor('claude-code-portless@example.com', verifier);
    const response = await redeem(code, verifier, 'http://localhost/callback');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });
});
