import process from 'node:process';
import type { Config, RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { MS_PER_SECOND, nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { signAccessToken } from '$lib/server/auth/jwtSigning.js';
import { getDb } from '$lib/server/db.js';

import { handle } from './hooks.server.js';

const JWT_SECRET = 'test-secret';
const ORIGIN = 'https://pbx.example.com';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
// A no-JavaScript submission of one of the login page's remote `form`s posts to the page itself.
const LOGIN_SUBMISSION = `${ORIGIN}/oauth/authorize?/remote=login`;

vi.mock('$lib/server/jobs/keyRotation.js', () => ({
  reencryptSweep: () => Promise.resolve()
}));

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = JWT_SECRET;
process.env.ORIGIN = ORIGIN;

// SvelteKit's built-in check runs before `handle` and refuses an origin-less form POST to any
// route; it is off when `csrf.trustedOrigins` lists `'*'` (what SvelteKit's sync writes as
// `csrf_check_origin`, the deprecated `checkOrigin` being unset), and while it is on no client
// request below reaches `handle`. The config is untyped JavaScript, so it is loaded through a
// specifier TypeScript does not resolve.
const CONFIG_URL = new URL('../svelte.config.js', import.meta.url).href;
const { default: config } = (await import(CONFIG_URL)) as { default: Config };
const svelteKitChecksOrigin = !(
  config.kit?.csrf?.trustedOrigins ?? []
).includes('*');

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: 'admin1',
      name: 'Admin',
      email: 'admin@x',
      role: 'admin',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
});

function eventFor(url: string, init: RequestInit): RequestEvent {
  return {
    request: new Request(url, init),
    url: new URL(url),
    locals: {},
    getClientAddress: () => '198.51.100.7'
  } as RequestEvent;
}

/** `handle`'s response, and whether it passed the request on to the route. */
async function serve(
  url: string,
  init: RequestInit
): Promise<{ response: Response; resolved: boolean }> {
  let resolved = false;
  const response = await handle({
    event: eventFor(url, init),
    resolve: () => {
      resolved = true;
      return Promise.resolve(new Response('ok'));
    }
  });
  return { response, resolved };
}

function audioUpload(): FormData {
  const body = new FormData();
  body.set('kind', 'moh');
  body.set('label', 'Hold music');
  body.set('upload', new Blob(['RIFF'], { type: 'audio/wav' }), 'hold.wav');
  return body;
}

describe('form submissions without an Origin header', () => {
  it('lets a bearer multipart POST /api/v1/audio through to the route', async () => {
    expect(svelteKitChecksOrigin).toBe(false);
    const token = signAccessToken(
      JWT_SECRET,
      { sub: 'admin1', role: 'admin', cid: null },
      Math.floor(Date.now() / MS_PER_SECOND),
      `${ORIGIN}/mcp`
    );
    const { resolved } = await serve(`${ORIGIN}/api/v1/audio`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: audioUpload()
    });
    expect(resolved).toBe(true);
  });

  it('answers a multipart POST /api/v1/audio without a token with 401, not a CSRF refusal', async () => {
    expect(svelteKitChecksOrigin).toBe(false);
    const { response } = await serve(`${ORIGIN}/api/v1/audio`, {
      method: 'POST',
      body: audioUpload()
    });
    expect(response.status).toBe(401);
  });

  it.each(['/oauth/token', '/oauth/revoke'])(
    'lets a form-encoded POST %s through to the endpoint',
    async path => {
      expect(svelteKitChecksOrigin).toBe(false);
      const { resolved } = await serve(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: FORM,
        body: 'grant_type=refresh_token&refresh_token=x&token=x'
      });
      expect(resolved).toBe(true);
    }
  );
});

describe('the login and consent page', () => {
  it('refuses a cross-site form POST with 403', async () => {
    const { response, resolved } = await serve(LOGIN_SUBMISSION, {
      method: 'POST',
      headers: { ...FORM, origin: 'https://evil.example' },
      body: 'action=approve'
    });
    expect(response.status).toBe(403);
    expect(resolved).toBe(false);
  });

  it('refuses a form POST without an Origin header with 403', async () => {
    const { response, resolved } = await serve(LOGIN_SUBMISSION, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: '--x--'
    });
    expect(response.status).toBe(403);
    expect(resolved).toBe(false);
  });

  it('lets a same-origin login submission through to the page', async () => {
    const { resolved } = await serve(LOGIN_SUBMISSION, {
      method: 'POST',
      headers: { ...FORM, origin: ORIGIN },
      body: 'email=admin%40x&_password=x&action=password'
    });
    expect(resolved).toBe(true);
  });

  it('lets the page itself load without an Origin header', async () => {
    const { resolved } = await serve(`${ORIGIN}/oauth/authorize`, {
      method: 'GET'
    });
    expect(resolved).toBe(true);
  });
});
