import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '#lib/server/db.js';
import { seedTenantTimeZone } from '#lib/server/testDb.js';

import { login } from './authorize.remote.js';

const KEY_BYTE_LENGTH = 32;
// §5.5 "Login | client address | 60 attempts per minute".
const LOGIN_ADDRESS_LIMIT = 60;

process.env.DB_FILE = ':memory:';
process.env.FQDN = 'pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

const current: { event: RequestEvent | undefined } = { event: undefined };

// `form` hands back the handler itself, so a test calls the `login` form's body directly, with the
// request event it would otherwise read from SvelteKit's request store. The `__.type` marker is
// what SvelteKit's own check of a `.remote.ts` module's exports looks for.
vi.mock('$app/server', () => ({
  form: (_schema: unknown, handler: object) =>
    Object.assign(handler, { __: { type: 'form' } }),
  getRequestEvent: () => current.event
}));

type LoginHandler = (payload: {
  email: string;
  _password: string;
  action: 'password' | 'sso';
}) => Promise<unknown>;

const submit = login as unknown as LoginHandler;

function eventFrom(address: string): RequestEvent {
  return {
    url: new URL('https://pbx.example.com/oauth/authorize'),
    cookies: { get: () => undefined, set: () => undefined },
    getClientAddress: () => address
  } as unknown as RequestEvent;
}

/** The HTTP status `promise` rejects with, or `undefined` when it rejects with anything else. */
async function statusOf(
  promise: Promise<unknown>
): Promise<number | undefined> {
  const err = await promise.catch((caught: unknown) => caught);
  return isHttpError(err) ? err.status : undefined;
}

beforeAll(async () => {
  // No SSO provider in `settings`: the SSO button then answers 400 "SSO is not configured",
  // which is enough to tell a submission the address limit let through from one it refused.
  const db = getDb();
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: 'owner',
      name: 'Owner',
      email: 'owner@example.com',
      role: 'owner',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  await seedTenantTimeZone(db, 'Europe/Berlin');
});

describe('the login form', () => {
  it('counts SSO submissions against the per-address login limit (§5.5)', async () => {
    current.event = eventFrom('198.51.100.7');
    const payload = { email: '', _password: '', action: 'sso' } as const;
    for (let attempt = 0; attempt < LOGIN_ADDRESS_LIMIT; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts are the point of this loop
      expect(await statusOf(submit(payload))).toBe(400);
    }
    expect(await statusOf(submit(payload))).toBe(429);
    // The limit is per address: another client is unaffected.
    current.event = eventFrom('198.51.100.8');
    expect(await statusOf(submit(payload))).toBe(400);
  });
});
