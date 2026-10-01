import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '#lib/db.js';

import { POST } from '../resetRequest/+server.js';
import { requestReset } from './forgot.remote.js';

const KEY_BYTE_LENGTH = 32;
// §5.5 "Forgot-password request | client address | 30 per hour" and "| account | 3 per hour".
const RESET_ADDRESS_LIMIT = 30;
const RESET_ACCOUNT_LIMIT = 3;

process.env.DB_FILE = ':memory:';
process.env.ORIGIN = 'https://pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

const current: { event: RequestEvent | undefined } = { event: undefined };

// `form` hands back the handler behind its schema, so a test calls the form's body with the
// payload SvelteKit would have parsed, and the request event it would read from its request
// store. The `__.type` marker is what SvelteKit's own check of a `.remote.ts` module's exports
// looks for.
vi.mock('$app/server', () => ({
  form: (
    schema: { parse: (input: unknown) => unknown },
    handler: (payload: unknown) => Promise<unknown>
  ) =>
    Object.assign((input: unknown) => handler(schema.parse(input)), {
      __: { type: 'form' }
    }),
  getRequestEvent: () => current.event
}));

// The relay is never reached: the reset token's row is what tells a sent mail from a dropped one.
vi.mock('#lib/mail/index.js', () => ({
  sendMail: () => Promise.resolve()
}));

const submit = requestReset as unknown as (
  payload: Record<string, unknown>
) => Promise<unknown>;

function eventFrom(address: string, body: unknown = null): RequestEvent {
  return {
    url: new URL('https://pbx.example.com/auth/forgot'),
    getClientAddress: () => address,
    request: { json: () => Promise.resolve(body) } as Request
  } as unknown as RequestEvent;
}

/** The HTTP status `promise` rejects with, or `undefined` when it rejects with anything else. */
async function statusOf(
  promise: Promise<unknown>
): Promise<number | undefined> {
  const err = await promise.catch((caught: unknown) => caught);
  return isHttpError(err) ? err.status : undefined;
}

async function setRelay(smtpHost: string | null): Promise<void> {
  await getDb()
    .updateTable('settings')
    .set({ smtpHost })
    .where('id', '=', 1)
    .execute();
}

async function resetTokenCount(userId: string): Promise<number> {
  const rows = await getDb()
    .selectFrom('tokens')
    .select('tokenHash')
    .where('userId', '=', userId)
    .where('kind', '=', 'reset')
    .execute();
  return rows.length;
}

beforeAll(async () => {
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
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, userId: 'owner' })
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
      emergencyNumbersJson: '["112"]',
      smtpHost: 'smtp.example.com'
    })
    .execute();
});

describe('the forgot-password form', () => {
  it('404s while no relay is configured, as POST /auth/resetRequest does (§10.2)', async () => {
    await setRelay(null);
    current.event = eventFrom('198.51.100.1');
    try {
      expect(await statusOf(submit({ email: 'owner@example.com' }))).toBe(404);
    } finally {
      await setRelay('smtp.example.com');
    }
  });

  it('answers the same confirmation for a known, an unknown and a malformed address (§5.5)', async () => {
    current.event = eventFrom('198.51.100.2');
    expect(await submit({ email: 'owner@example.com' })).toEqual({
      sent: true
    });
    expect(await submit({ email: 'nobody@example.com' })).toEqual({
      sent: true
    });
    expect(await submit({ email: 'not an address' })).toEqual({ sent: true });
    expect(await submit({})).toEqual({ sent: true });
    await vi.waitFor(async () => {
      expect(await resetTokenCount('owner')).toBe(1);
    });
  });

  it('shares the per-address limit with POST /auth/resetRequest and answers 429 past it (§5.5)', async () => {
    const address = '198.51.100.3';
    current.event = eventFrom(address);
    const half = RESET_ADDRESS_LIMIT / 2;
    for (let attempt = 0; attempt < half; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts are the point of this loop
      expect(await submit({ email: 'nobody@example.com' })).toEqual({
        sent: true
      });
      // eslint-disable-next-line new-cap, no-await-in-loop -- the fixed SvelteKit handler name; sequential attempts
      const rest = await POST(
        eventFrom(address, { email: 'nobody@example.com' })
      );
      expect(rest.status).toBe(202);
    }
    expect(await statusOf(submit({ email: 'nobody@example.com' }))).toBe(429);
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const refused = await POST(eventFrom(address, { email: 'x@example.com' }));
    expect(refused.status).toBe(429);
    // The limit is per address: another client is unaffected.
    current.event = eventFrom('198.51.100.4');
    expect(await submit({ email: 'nobody@example.com' })).toEqual({
      sent: true
    });
  });

  it('shares the per-account limit with POST /auth/resetRequest, dropping the mail silently past it (§5.5)', async () => {
    const db = getDb();
    await db
      .insertInto('users')
      .values({
        id: 'anna',
        name: 'Anna',
        email: 'anna@example.com',
        role: 'user',
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
    current.event = eventFrom('198.51.100.5');
    expect(await submit({ email: 'anna@example.com' })).toEqual({
      sent: true
    });
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const viaRest = await POST(
      eventFrom('198.51.100.5', { email: 'ANNA@example.com' })
    );
    expect(viaRest.status).toBe(202);
    expect(await submit({ email: 'Anna@Example.com' })).toEqual({
      sent: true
    });
    await vi.waitFor(async () => {
      expect(await resetTokenCount('anna')).toBe(RESET_ACCOUNT_LIMIT);
    });
    // Past the limit: the same confirmation, but no further token (and so no mail).
    expect(await submit({ email: 'anna@example.com' })).toEqual({
      sent: true
    });
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    expect(await resetTokenCount('anna')).toBe(RESET_ACCOUNT_LIMIT);
  });
});
