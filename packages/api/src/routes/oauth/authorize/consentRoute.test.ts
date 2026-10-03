import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isRedirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import * as privateEnv from '$app/env/private';
import { beforeAll, describe, expect, it } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { encodeMetadataClientId } from '#lib/server/auth/clients.js';
import { CONSENT_COOKIE } from '#lib/server/auth/consent.js';
import { setSealedCookie } from '#lib/server/auth/sealedCookie.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { load } from './+page.server.js';
import { approveConsentSubmit } from './consentSubmit.js';

const KEY_BYTE_LENGTH = 32;
const FQDN = 'pbx.example.com';
const ORIGIN = `https://${FQDN}`;
const REDIRECT_A = 'https://a.example.com/callback';
const REDIRECT_B = 'https://b.example.com/callback';

process.env.DB_FILE = ':memory:';
process.env.FQDN = FQDN;
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

function clientIdFor(name: string, redirectUri: string): string {
  return encodeMetadataClientId(keyringFromEnv(privateEnv), {
    name,
    redirectUris: [redirectUri],
    applicationType: 'web'
  });
}

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: 'user-1',
      name: 'Anna',
      email: 'anna@example.com',
      role: 'owner',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('forwardTargets')
    .values({ id: 'ft1', userId: 'user-1' })
    .execute();
  await db
    .insertInto('dids')
    .values({
      id: 'did1',
      number: '+491234567',
      targetId: 'ft1',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Acme',
      mainDidId: 'did1',
      country: 'DE',
      language: 'en',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
});

/** An in-memory `event.cookies`, the way a browser carries `zamfono_consent` between requests. */
function cookieJar(): {
  get: (name: string) => string | undefined;
  set: (name: string, value: string) => void;
  delete: (name: string) => void;
} {
  const store = new Map<string, string>();
  return {
    get: name => store.get(name),
    set: (name, value) => {
      store.set(name, value);
    },
    delete: name => {
      store.delete(name);
    }
  };
}

type Jar = ReturnType<typeof cookieJar>;

function sealConsent(
  jar: Jar,
  clientId: string,
  clientName: string,
  state: string | null = 'state-a'
): void {
  setSealedCookie(
    jar as unknown as Cookies,
    keyringFromEnv(privateEnv),
    CONSENT_COOKIE,
    {
      userId: 'user-1',
      clientName,
      authorize: {
        clientId,
        redirectUri: REDIRECT_A,
        codeChallenge: 'challenge-a',
        scope: 'openid',
        state
      }
    }
  );
}

function authorizeUrl(clientId: string, redirectUri: string): URL {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  const params: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: 'state-b',
    code_challenge: 'challenge-b',
    scope: 'openid'
  };
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url;
}

function loadFor(url: URL, cookies: Jar): ReturnType<typeof load> {
  return load({ url, cookies } as unknown as Parameters<typeof load>[0]);
}

describe('GET /oauth/authorize with a pending consent cookie', () => {
  it('resolves a fresh authorization request rather than the sealed one it shadows', async () => {
    const jar = cookieJar();
    sealConsent(jar, clientIdFor('Client A', REDIRECT_A), 'Client A');
    const clientB = clientIdFor('Client B', REDIRECT_B);
    const data = await loadFor(authorizeUrl(clientB, REDIRECT_B), jar);
    expect(data.consent).toBeNull();
    expect(data.authorize?.clientId).toBe(clientB);
    expect(data.clientName).toBe('Client B');
  });

  it('renders the sealed consent step for the request it was sealed for', async () => {
    const jar = cookieJar();
    const clientA = clientIdFor('Client A', REDIRECT_A);
    sealConsent(jar, clientA, 'Client A');
    const url = new URL(`${ORIGIN}/oauth/authorize`);
    const params: Record<string, string> = {
      client_id: clientA,
      redirect_uri: REDIRECT_A,
      state: 'state-a',
      code_challenge: 'challenge-a',
      scope: 'openid'
    };
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const data = await loadFor(url, jar);
    expect(data.consent).toEqual({
      clientName: 'Client A',
      redirectUri: REDIRECT_A
    });
  });

  it('renders the sealed consent step for a request that sent no state (OAuth 2.1 §4.1.1)', async () => {
    const jar = cookieJar();
    const clientA = clientIdFor('Client A', REDIRECT_A);
    sealConsent(jar, clientA, 'Client A', null);
    const url = new URL(`${ORIGIN}/oauth/authorize`);
    url.searchParams.set('client_id', clientA);
    url.searchParams.set('redirect_uri', REDIRECT_A);
    url.searchParams.set('code_challenge', 'challenge-a');
    url.searchParams.set('scope', 'openid');
    const data = await loadFor(url, jar);
    expect(data.consent).toEqual({
      clientName: 'Client A',
      redirectUri: REDIRECT_A
    });
  });

  it('renders the sealed consent step for the bare return from the SSO callback', async () => {
    const jar = cookieJar();
    sealConsent(jar, clientIdFor('Client A', REDIRECT_A), 'Client A');
    const data = await loadFor(new URL(`${ORIGIN}/oauth/authorize`), jar);
    expect(data.consent).toEqual({
      clientName: 'Client A',
      redirectUri: REDIRECT_A
    });
  });
});

describe('the consent step, approved', () => {
  it('mints no code when the client row cannot be written', async () => {
    const jar = cookieJar();
    // A `client_id` that resolves to no metadata: `oauth_clients` gets no row, and a code minted
    // here would be redeemed against a `tokens.client_id` with nothing to reference (§5.2).
    sealConsent(jar, 'not-a-resolvable-client-id', 'Client A');
    const err = await approveConsentSubmit({
      cookies: jar,
      url: new URL(`${ORIGIN}/oauth/authorize`)
    } as unknown as RequestEvent).catch((caught: unknown) => caught);
    if (!isRedirect(err)) {
      throw new Error('expected a redirect');
    }
    const location = new URL(err.location);
    expect(location.origin).toBe('https://a.example.com');
    expect(location.searchParams.get('code')).toBeNull();
    expect(location.searchParams.get('error')).toBe('server_error');
    expect(location.searchParams.get('state')).toBe('state-a');
    // RFC 9207: an error response names its issuer just as a success does (§5.2).
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
  });
});
