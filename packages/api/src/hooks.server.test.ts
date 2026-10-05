import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { epochSeconds, nowIso } from '@zamfono/shared';
import { migrateForTest, seedSettings } from '@zamfono/shared/testDb.js';

import { encodeLinkToken, signAccessToken } from '#lib/server/auth/jwt.js';
import { getDb } from '#lib/server/db.js';
import { requestEvent } from '#testing/requestEvent.js';
import { seedSession } from '#testing/testDb.js';

import { handle, init as initHooks } from './hooks.server.js';
import { GET as getOpenApi } from './routes/api/v1/openapi.json/+server.js';

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
  await seedSession(db, 'admin1', 'console', 'session-1');
  await seedSettings(db, { language: 'de' });
});

// The route SvelteKit matches for every REST operation.
const API_ROUTE = '/api/v1/[...path]';

const resolvePassThrough = (): Promise<Response> =>
  Promise.resolve(new Response('ok'));

describe('hooks handle', () => {
  it('refuses /internal/* carrying X-Forwarded-For with 404', async () => {
    const event = requestEvent('http://internal/internal/mail', {
      routeId: '/internal/mail',
      init: { headers: { 'x-forwarded-for': '203.0.113.9' } }
    });
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(404);
  });

  it('refuses /readyz carrying X-Forwarded-For with 404', async () => {
    const event = requestEvent('http://internal/readyz', {
      routeId: '/readyz',
      init: { headers: { 'x-forwarded-for': '203.0.113.9' } }
    });
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(404);
  });

  it('resolves /internal/* through without the header', async () => {
    const event = requestEvent('http://internal/internal/mail', {
      routeId: '/internal/mail'
    });
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(await response.text()).toBe('ok');
  });

  it('answers 401 problem+json for /api/v1/* without a bearer token', async () => {
    const event = requestEvent('http://internal/api/v1/users', {
      routeId: API_ROUTE
    });
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json'
    );
  });

  it('serves the openapi document without a bearer token', async () => {
    const event = requestEvent('http://internal/api/v1/openapi.json', {
      routeId: '/api/v1/openapi.json'
    });
    const response = await handle({
      event,
      resolve: () => Promise.resolve(getOpenApi())
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ openapi: '3.1.0' });
  });

  it('answers 429 problem+json once a client address exceeds the token endpoint limit', async () => {
    const TOKEN_LIMIT_PER_MINUTE = 60;
    const address = '203.0.113.50';
    const responses: Response[] = [];
    for (let attempt = 0; attempt < TOKEN_LIMIT_PER_MINUTE + 1; attempt += 1) {
      const event = requestEvent('http://internal/oauth/token', {
        routeId: '/oauth/token',
        clientAddress: address
      });
      // eslint-disable-next-line no-await-in-loop -- each request must count before the next is made
      responses.push(await handle({ event, resolve: resolvePassThrough }));
    }
    const last = responses.at(-1);
    expect(last?.status).toBe(429);
    expect(last?.headers.get('content-type')).toBe('application/problem+json');
    expect(last?.headers.get('retry-after')).toBeTruthy();
  });

  // SvelteKit routes on the decoded path (`decode_pathname`), so each percent-encoded spelling
  // below runs the route its decoded path names.
  it('counts a percent-encoded spelling of the token endpoint against its limit', async () => {
    const TOKEN_LIMIT_PER_MINUTE = 60;
    const address = '203.0.113.53';
    const responses: Response[] = [];
    for (let attempt = 0; attempt < TOKEN_LIMIT_PER_MINUTE + 1; attempt += 1) {
      const event = requestEvent('http://internal/oauth/%74oken', {
        routeId: '/oauth/token',
        clientAddress: address
      });
      // eslint-disable-next-line no-await-in-loop -- each request must count before the next is made
      responses.push(await handle({ event, resolve: resolvePassThrough }));
    }
    expect(responses.at(-1)?.status).toBe(429);
  });

  it('refuses a percent-encoded /internal/* spelling carrying X-Forwarded-For with 404', async () => {
    const event = requestEvent('http://internal/%69nternal/mail', {
      routeId: '/internal/mail',
      init: { headers: { 'x-forwarded-for': '203.0.113.9' } }
    });
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(404);
  });

  it('answers 401 for a percent-encoded /api/v1/* spelling without a bearer token', async () => {
    const event = requestEvent('http://internal/%61pi/v1/users', {
      routeId: API_ROUTE
    });
    const response = await handle({ event, resolve: resolvePassThrough });
    expect(response.status).toBe(401);
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
      const event = requestEvent('http://internal/oauth/register', {
        routeId: '/oauth/register',
        clientAddress: address
      });
      // eslint-disable-next-line no-await-in-loop -- each request must count before the next is made
      responses.push(await handle({ event, resolve: resolvePassThrough }));
    }
    expect(await responses.at(-2)?.text()).toBe('ok');
    expect(responses.at(-1)?.status).toBe(429);
  });

  it('does not rate limit a client registration request under the limit', async () => {
    const event = requestEvent('http://internal/oauth/register', {
      routeId: '/oauth/register',
      clientAddress: '203.0.113.51'
    });
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

  // §6.1, §6.3 "Environment": the mode's public address is required, like FQDN and the secrets.
  it('refuses to start while neither EXTERNAL_IPV4 nor STACK_IPV4 is set', async () => {
    vi.stubEnv('EXTERNAL_IPV4', '');
    vi.stubEnv('STACK_IPV4', '');
    jobs.start.mockClear();
    await expect(initHooks()).rejects.toThrow(
      'neither EXTERNAL_IPV4 nor STACK_IPV4 is set'
    );
    expect(jobs.start).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('sets locals.auth from a valid bearer token: the user, its session, the client and its name', async () => {
    await getDb()
      .insertInto('oauthClients')
      .values({
        clientId: 'client1',
        name: 'Ops Console',
        kind: 'cimd',
        createdAt: nowIso(),
        lastLoginAt: nowIso()
      })
      .execute();
    const nowS = epochSeconds(Date.now());
    const token = await signAccessToken(
      JWT_SECRET,
      { sub: 'admin1', role: 'admin', cid: 'client1', sid: 'session-1' },
      nowS,
      'https://pbx.example.com'
    );
    const event = requestEvent('http://internal/api/v1/users', {
      routeId: API_ROUTE,
      init: { headers: { authorization: `Bearer ${token}` } }
    });
    await handle({ event, resolve: resolvePassThrough });
    expect(event.locals.auth).toEqual({
      actor: { id: 'admin1', name: 'Admin', role: 'admin' },
      sessionId: 'session-1',
      clientId: 'client1',
      clientName: 'Ops Console'
    });
  });

  it('marks a response to a download link private, and one to a bearer token not', async () => {
    const nowS = epochSeconds(Date.now());
    const path = '/api/v1/voicemails/vm1/audio';
    const linkToken = await encodeLinkToken(JWT_SECRET, 'download', {
      sub: 'admin1',
      cid: null,
      aud: path,
      iat: nowS,
      exp: nowS + 300
    });
    const linked = requestEvent(
      `http://internal${path}?access_token=${linkToken}`,
      { routeId: API_ROUTE }
    );
    const viaLink = await handle({
      event: linked,
      resolve: resolvePassThrough
    });
    expect(linked.locals.auth?.actor.id).toBe('admin1');
    expect(viaLink.headers.get('cache-control')).toBe('private');
    const bearerToken = await signAccessToken(
      JWT_SECRET,
      { sub: 'admin1', role: 'admin', cid: null, sid: 'session-1' },
      nowS,
      'https://pbx.example.com'
    );
    const viaBearer = await handle({
      event: requestEvent(`http://internal${path}`, {
        routeId: API_ROUTE,
        init: { headers: { authorization: `Bearer ${bearerToken}` } }
      }),
      resolve: resolvePassThrough
    });
    expect(viaBearer.headers.get('cache-control')).toBeNull();
  });

  // §5.2 "Authentication pages": every page is in `settings.language`, its `<html lang>` too.
  it("fills a page's html lang with the tenant's language", async () => {
    const event = requestEvent('http://internal/oauth/authorize');
    const response = await handle({
      event,
      resolve: async (_event, options) =>
        new Response(
          await options?.transformPageChunk?.({
            html: '<html lang="%lang%">',
            done: true
          })
        )
    });
    expect(await response.text()).toBe('<html lang="de">');
  });
});
