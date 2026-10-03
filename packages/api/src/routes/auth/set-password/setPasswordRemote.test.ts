import process from 'node:process';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { MIN_PASSWORD_LENGTH } from '#lib/auth/passwordPolicy.js';
import { verifyPassword } from '#lib/server/auth/password.js';
import { issueResetToken } from '#lib/server/auth/tokens.js';
import { getDb } from '#lib/server/db.js';
import { sha256Hex } from '#lib/server/hash.js';

import { POST } from '../reset/+server.js';
import { load } from './+page.server.js';
import { setPassword } from './setPassword.remote.js';

const PASSWORD = 'a brand new password';
const TOO_SHORT = `The password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`;

process.env.DB_FILE = ':memory:';

// `form` hands back the handler behind its schema, so a test calls the form's body with the
// payload SvelteKit would have parsed. The `__.type` marker is what SvelteKit's own check of a
// `.remote.ts` module's exports looks for.
vi.mock('$app/server', () => ({
  form: (
    schema: { parse: (input: unknown) => unknown },
    handler: (payload: unknown) => Promise<unknown>
  ) =>
    Object.assign((input: unknown) => handler(schema.parse(input)), {
      __: { type: 'form' }
    })
}));

const submit = setPassword as unknown as (
  payload: Record<string, unknown>
) => Promise<unknown>;

/** Where `promise` redirects to, or `undefined` when it settles any other way. */
async function redirectOf(
  promise: unknown
): Promise<{ status: number; location: string } | undefined> {
  const outcome = await Promise.resolve(promise).catch(
    (caught: unknown) => caught
  );
  return isRedirect(outcome)
    ? { status: outcome.status, location: outcome.location }
    : undefined;
}

async function newUser(email: string): Promise<string> {
  const id = newId();
  await getDb()
    .insertInto('users')
    .values({
      id,
      name: email,
      email,
      role: 'user',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function tokenRevoked(raw: string): Promise<boolean> {
  const row = await getDb()
    .selectFrom('tokens')
    .select('revokedAt')
    .where('tokenHash', '=', sha256Hex(raw))
    .executeTakeFirstOrThrow();
  return row.revokedAt !== null;
}

function pageEvent(search: string): Parameters<typeof load>[0] {
  return {
    url: new URL(`https://pbx.example.com/auth/set-password${search}`)
  } as unknown as Parameters<typeof load>[0];
}

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  const ownerId = await newUser('owner@example.com');
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, userId: ownerId })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+491234567', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Acme',
      mainDidId: didId,
      country: 'DE',
      language: 'en',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
});

describe('the set-password form', () => {
  it('sets the password and redirects to the confirmation; the link then no longer redeems', async () => {
    const userId = await newUser('ben@example.com');
    const { raw } = await issueResetToken(getDb(), userId, 'reset', nowIso());
    expect(
      await redirectOf(submit({ token: raw, _password: PASSWORD }))
    ).toEqual({
      status: 303,
      location: '/auth/set-password?done'
    });
    const user = await getDb()
      .selectFrom('users')
      .select('passwordHash')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
    expect(await tokenRevoked(raw)).toBe(true);
    // The same token checks as `POST /auth/reset`: a link the form redeemed is refused there too.
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const rest = await POST({
      request: {
        json: () => Promise.resolve({ token: raw, password: PASSWORD })
      }
    } as unknown as RequestEvent);
    expect(rest.status).toBe(400);
    // …and the page's own load sends it to the expired-link error page.
    expect(await redirectOf(load(pageEvent(`?token=${raw}`)))).toEqual({
      status: 302,
      location: '/auth/error?reason=expired'
    });
  });

  it('refuses a too-short password with the page message, leaving the link redeemable', async () => {
    const userId = await newUser('cleo@example.com');
    const { raw } = await issueResetToken(getDb(), userId, 'reset', nowIso());
    expect(await submit({ token: raw, _password: 'short' })).toEqual({
      message: TOO_SHORT
    });
    expect(await submit({ token: raw })).toEqual({
      message: TOO_SHORT
    });
    expect(await tokenRevoked(raw)).toBe(false);
  });

  it('refuses an unknown or already-redeemed link with the invalid-link message', async () => {
    expect(
      await submit({ token: 'never-issued', _password: PASSWORD })
    ).toEqual({ message: 'This link has expired or was already used.' });
    const userId = await newUser('dora@example.com');
    const { raw } = await issueResetToken(getDb(), userId, 'reset', nowIso());
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const rest = await POST({
      request: {
        json: () => Promise.resolve({ token: raw, password: PASSWORD })
      }
    } as unknown as RequestEvent);
    expect(rest.status).toBe(200);
    expect(await submit({ token: raw, _password: PASSWORD })).toEqual({
      message: 'This link has expired or was already used.'
    });
  });
});

describe('GET /auth/set-password (load)', () => {
  it('renders the confirmation the form redirects to, without a token', async () => {
    const data = await load(pageEvent('?done'));
    expect(data).toEqual({ token: null, done: true });
  });
});
