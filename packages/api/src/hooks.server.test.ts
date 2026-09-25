import { randomBytes } from 'node:crypto';
import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { handle } from './hooks.server.js';
import { signAccessToken } from './lib/auth/jwt.js';
import { getDb } from './lib/db.js';

const MS_PER_SECOND = 1000;
const JWT_SECRET = 'test-secret';
const KEY_BYTE_LENGTH = 32;

// A sweep this test releases by hand, so a request can be issued while it is still running.
const sweep = vi.hoisted(() => {
  let release = (): void => undefined;
  const finished = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    finished,
    release: (): void => {
      release();
    }
  };
});
vi.mock('./lib/jobs/keyRotation.js', () => ({
  reencryptSweep: () => sweep.finished
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
  it('serves no request before the boot key-rotation sweep has finished', async () => {
    process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;
    vi.resetModules();
    const fresh = await import('./hooks.server.js');
    let served = false;
    // SvelteKit types `handle` as returning `MaybePromise<Response>`; awaiting it through
    // `Promise.resolve` gives the settled-ness this test observes without asserting it is async.
    const response = Promise.resolve(
      fresh.handle({
        event: eventFor('http://internal/internal/mail'),
        resolve: resolvePassThrough
      })
    ).then(result => {
      served = true;
      return result;
    });
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
    expect(served).toBe(false);
    sweep.release();
    expect(await (await response).text()).toBe('ok');
  });

  it('sets locals.actor and locals.clientId from a valid bearer token', async () => {
    const nowS = Math.floor(Date.now() / MS_PER_SECOND);
    const token = signAccessToken(
      JWT_SECRET,
      { sub: 'admin1', role: 'admin', cid: 'client1' },
      nowS,
      'https://pbx.example.com/mcp'
    );
    const event = eventFor('http://internal/api/v1/users', {
      headers: { authorization: `Bearer ${token}` }
    });
    await handle({ event, resolve: resolvePassThrough });
    expect(event.locals.actor).toEqual({
      id: 'admin1',
      name: 'Admin',
      role: 'admin'
    });
    expect(event.locals.clientId).toBe('client1');
  });
});
