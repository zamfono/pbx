import { randomBytes } from 'node:crypto';
import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { epochSeconds, nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { encodeDownloadToken } from '#lib/server/auth/jwt.js';
import { signAccessToken } from '#lib/server/auth/jwtSigning.js';
import { getDb } from '#lib/server/db.js';

import { handle, init as initHooks } from './hooks.server.js';

const JWT_SECRET = 'test-secret';
const KEY_BYTE_LENGTH = 32;

// Background jobs this test releases by hand, so `init` can be observed while they still start.
const jobs = vi.hoisted(() => {
  let release = (): void => undefined;
  const started = new Promise<void>(resolve => {
    release = resolve;
  });
  const stop = vi.fn();
  return {
    stop,
    start: vi.fn(() => started.then(() => ({ stop }))),
    release: (): void => {
      release();
    }
  };
});
vi.mock('#lib/server/jobs/background.js', () => ({
  startBackgroundJobs: jobs.start
}));

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = JWT_SECRET;

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

/** A minimal `RequestEvent`-shaped value: `handle` reads only `request`, `url`, `locals` and `getClientAddress`. */
function eventFor(
  url: string,
  init?: RequestInit,
  clientAddress = '198.51.100.1'
): RequestEvent {
  return {
    request: new Request(url, init),
    url: new URL(url),
    locals: {},
    getClientAddress: () => clientAddress
  } as RequestEvent;
}

const resolvePassThrough = (): Promise<Response> =>
  Promise.resolve(new Response('ok'));

describe('hooks handle', () => {
  it('refuses /internal/* carrying X-Forwarded-For with 404', async () => {
    const event = eventFor('http://internal/internal/mail', {
      headers: { 'x-forwarded-for': '203.0.113.9' }
    });
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(404);
  });

  it('resolves /internal/* through without the header', async () => {
    const event = eventFor('http://internal/internal/mail');
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(await response.text()).toBe('ok');
  });

  it('answers 401 problem+json for /api/v1/* without a bearer token', async () => {
    const event = eventFor('http://internal/api/v1/users');
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json'
    );
  });

  it('answers 401 for the openapi document without a bearer token', async () => {
    const event = eventFor('http://internal/api/v1/openapi.json');
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(401);
  });

  it('answers 429 problem+json once a client address exceeds the token endpoint limit', async () => {
    const TOKEN_LIMIT_PER_MINUTE = 60;
    const address = '203.0.113.50';
    const responses: Response[] = [];
    for (let attempt = 0; attempt < TOKEN_LIMIT_PER_MINUTE + 1; attempt += 1) {
      const event = eventFor('http://internal/oauth/token', undefined, address);
      // eslint-disable-next-line no-await-in-loop -- each request must count before the next is made
      responses.push(await handle({ event, resolve: resolvePassThrough }));
    }
    const last = responses.at(-1);
    expect(last?.status).toBe(429);
    expect(last?.headers.get('content-type')).toBe('application/problem+json');
    expect(last?.headers.get('retry-after')).toBeTruthy();
  });

  it('answers 429 problem+json once a client address exceeds the registration limit', async () => {
    const REGISTER_LIMIT_PER_MINUTE = 60;
    const address = '203.0.113.52';
    const responses: Response[] = [];
    for (
      let attempt = 0;
      attempt < REGISTER_LIMIT_PER_MINUTE + 1;
      attempt += 1
    ) {
      const event = eventFor(
        'http://internal/oauth/register',
        undefined,
        address
      );
      // eslint-disable-next-line no-await-in-loop -- each request must count before the next is made
      responses.push(await handle({ event, resolve: resolvePassThrough }));
    }
    expect(await responses.at(-2)?.text()).toBe('ok');
    expect(responses.at(-1)?.status).toBe(429);
  });

  it('does not rate limit a client registration request under the limit', async () => {
    const event = eventFor(
      'http://internal/oauth/register',
      undefined,
      '203.0.113.51'
    );
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(await response.text()).toBe('ok');
  });

  // §5.4: "At boot, before it serves a request, `api` sweeps every `*_enc` column". A fresh
  // module instance, with the environment the sweep needs, starts its own boot sweep.
  it('resolves init once the background jobs have started, and stops them on shutdown', async () => {
    process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;
    let initialized = false;
    const initializing = Promise.resolve(initHooks()).then(() => {
      initialized = true;
    });
    await vi.waitFor(() => {
      expect(jobs.start).toHaveBeenCalledOnce();
    });
    expect(initialized).toBe(false);
    jobs.release();
    await initializing;

    process.emit('sveltekit:shutdown', 'SIGTERM');
    expect(jobs.stop).toHaveBeenCalledOnce();
  });

  it('sets locals.auth from a valid bearer token: the user, the client and its name', async () => {
    await getDb()
      .insertInto('oauthClients')
      .values({
        clientId: 'client1',
        name: 'Ops Console',
        kind: 'cimd',
        redirectUrisJson: '[]',
        createdAt: nowIso(),
        lastLoginAt: nowIso()
      })
      .execute();
    const nowS = epochSeconds(Date.now());
    const token = await signAccessToken(
      JWT_SECRET,
      { sub: 'admin1', role: 'admin', cid: 'client1' },
      nowS,
      'https://pbx.example.com'
    );
    const event = eventFor('http://internal/api/v1/users', {
      headers: { authorization: `Bearer ${token}` }
    });
    await handle({ event, resolve: resolvePassThrough });
    expect(event.locals.auth).toEqual({
      actor: { id: 'admin1', name: 'Admin', role: 'admin' },
      clientId: 'client1',
      clientName: 'Ops Console'
    });
  });

  it('marks a response to a download link private, and one to a bearer token not', async () => {
    const nowS = epochSeconds(Date.now());
    const path = '/api/v1/voicemails/vm1/audio';
    const linkToken = await encodeDownloadToken(JWT_SECRET, {
      sub: 'admin1',
      cid: null,
      aud: path,
      iat: nowS,
      exp: nowS + 300
    });
    const linked = eventFor(`http://internal${path}?access_token=${linkToken}`);
    const viaLink = await handle({
      event: linked,
      resolve: resolvePassThrough
    });
    expect(linked.locals.auth?.actor.id).toBe('admin1');
    expect(viaLink.headers.get('cache-control')).toBe('private');
    const bearerToken = await signAccessToken(
      JWT_SECRET,
      { sub: 'admin1', role: 'admin', cid: null },
      nowS,
      'https://pbx.example.com'
    );
    const viaBearer = await handle({
      event: eventFor(`http://internal${path}`, {
        headers: { authorization: `Bearer ${bearerToken}` }
      }),
      resolve: resolvePassThrough
    });
    expect(viaBearer.headers.get('cache-control')).toBeNull();
  });
});
