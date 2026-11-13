/**
 * A credential reset committing between a sign-in's `credential_epoch` check and the write it lets
 * through (§5.2): the write is refused, or lands before the reset, which then takes it back. The
 * reset runs as `reset-mfa.mjs` does, on a second connection to the same database file, right
 * after the first read of a given table once armed (`users`, which the check reads, unless the
 * window follows another read); while the write's transaction holds the write lock it is refused
 * at once (`busy_timeout` 0) and runs after the step instead.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import * as privateEnv from '$app/env/private';
import {
  sql,
  type KyselyPlugin,
  type QueryId,
  type RootOperationNode,
  type TableNode
} from 'kysely';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  credentialEpoch,
  newId,
  nowIso,
  openDb,
  resetMfa,
  type Db
} from '@zamfono/shared';
import { migrateForTest, seedSettings } from '@zamfono/shared/testDb.js';

import { authenticateToken } from '#lib/server/auth/bearer.js';
import { encodeMetadataClientId } from '#lib/server/auth/clients.js';
import { AuthCodeStore } from '#lib/server/auth/codes.js';
import { totpAt } from '#lib/server/auth/mfa/totp.js';
import { newPersonalAccessToken } from '#lib/server/auth/personalAccessTokens.js';
import { tokenEndpoint } from '#lib/server/auth/tokenEndpoint.js';
import { pkceS256 } from '#lib/server/hash.js';
import { limiter } from '#lib/server/limiter.js';
import { runOperation } from '#lib/server/ops/runner.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import {
  cookieJar,
  requestEvent,
  type CookieJar
} from '#testing/requestEvent.js';
import {
  ORIGIN,
  PASSWORD,
  secretOf,
  seedPerson,
  signIn,
  submitSecond
} from '#testing/signInKit.js';

import type { ManageResult } from './security/securityAccount.js';
import { manageSubmit, type ManagePayload } from './security/securityManage.js';
import { securitySignIn } from './security/securitySignIn.js';

import '#lib/server/ops/personalAccessTokens/index.js';

const state = vi.hoisted(() => ({ db: undefined as Db | undefined }));

vi.mock('#lib/server/db.js', () => ({
  getDb: () => {
    if (state.db === undefined) {
      throw new Error('the database is opened in beforeAll');
    }
    return state.db;
  }
}));

vi.mock('#lib/server/mail/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#lib/server/mail/index.js')>()),
  sendMail: vi.fn(() => Promise.resolve('sent'))
}));

const KEY_BYTE_LENGTH = 32;
const JWT_SECRET = 'credential-epoch-race-secret';
const REDIRECT_URI = 'https://client.example.com/callback';
const VERIFIER = 'a-code-verifier-of-enough-length';

process.env.FQDN = 'pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

/** The reset to commit right after the next read of its table, once armed. */
let armed: { table: string; reset: () => Promise<void> } | null = null;
const armedReads = new WeakSet<QueryId>();

function reads(node: RootOperationNode, table: string): boolean {
  return (
    node.kind === 'SelectQueryNode' &&
    (node.from?.froms.some(
      from =>
        from.kind === 'TableNode' &&
        (from as TableNode).table.identifier.name === table
    ) ??
      false)
  );
}

const resetAfterRead: KyselyPlugin = {
  transformQuery: ({ node, queryId }) => {
    if (armed !== null && reads(node, armed.table)) {
      armedReads.add(queryId);
    }
    return node;
  },
  transformResult: async ({ queryId, result }) => {
    const reset = armed?.reset;
    if (reset !== undefined && armedReads.has(queryId)) {
      armed = null;
      await reset();
    }
    return result;
  }
};

/** The second connection, which the reset runs on, waiting for no lock. */
let other: Db;
let clientId = '';

beforeAll(async () => {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'zamfono-race-')),
    'pbx.db'
  );
  const database = openDb(file);
  await migrateForTest(database);
  await seedSettings(database, { companyName: 'Acme', language: 'en' });
  state.db = database.withPlugin(resetAfterRead);
  other = openDb(file);
  await sql`pragma busy_timeout = 0`.execute(other);
  clientId = encodeMetadataClientId(keyringFromEnv(privateEnv), {
    name: 'Test Client',
    redirectUris: [REDIRECT_URI],
    applicationType: 'web'
  });
  await database
    .insertInto('oauthClients')
    .values({
      clientId,
      name: 'Test Client',
      kind: 'cimd',
      createdAt: nowIso(),
      lastLoginAt: nowIso()
    })
    .execute();
});

function db(): Db {
  if (state.db === undefined) {
    throw new Error('the database is opened in beforeAll');
  }
  return state.db;
}

/** An MFA reset of `userId` on the other connection. */
async function resetOn(userId: string): Promise<void> {
  await other
    .transaction()
    .execute(async trx => resetMfa(trx, userId, nowIso()));
}

/**
 * Runs `step` with an MFA reset of `userId` armed for the first read of `table` it makes; a reset
 * the step's write lock refused runs once the step is done. Answers what the step settled with.
 */
async function racedWithReset(
  userId: string,
  step: () => Promise<unknown>,
  table = 'users'
): Promise<unknown> {
  const race = { fired: false, refused: false };
  armed = {
    table,
    reset: async () => {
      race.fired = true;
      try {
        await resetOn(userId);
      } catch (err) {
        if ((err as { code?: string }).code !== 'SQLITE_BUSY') {
          throw err;
        }
        race.refused = true;
      }
    }
  };
  const outcome = await step().catch((err: unknown) => err);
  armed = null;
  expect(race.fired).toBe(true);
  if (race.refused) {
    await resetOn(userId);
  }
  return outcome;
}

/** What `userId` holds after the race: none of it may outlive the reset. */
async function held(userId: string): Promise<Record<string, number>> {
  const now = nowIso();
  const count = async (
    query: Promise<{ n: number | string | bigint }>
  ): Promise<number> => Number((await query).n);
  return {
    sessions: await count(
      other
        .selectFrom('tokens')
        .select(eb => eb.fn.countAll().as('n'))
        .where('userId', '=', userId)
        .where('kind', '=', 'refresh')
        .where('revokedAt', 'is', null)
        .where('expiresAt', '>', now)
        .executeTakeFirstOrThrow()
    ),
    personalAccessTokens: await count(
      other
        .selectFrom('personalAccessTokens')
        .select(eb => eb.fn.countAll().as('n'))
        .where('userId', '=', userId)
        .where('revokedAt', 'is', null)
        .executeTakeFirstOrThrow()
    ),
    authenticators: await count(
      other
        .selectFrom('totpCredentials')
        .select(eb => eb.fn.countAll().as('n'))
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow()
    ),
    recoveryCodes: await count(
      other
        .selectFrom('recoveryCodes')
        .select(eb => eb.fn.countAll().as('n'))
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow()
    )
  };
}

const NOTHING_HELD = {
  sessions: 0,
  personalAccessTokens: 0,
  authenticators: 0,
  recoveryCodes: 0
};

async function seedAdmin(): Promise<{ email: string; userId: string }> {
  const email = `admin-${randomBytes(4).toString('hex')}@example.com`;
  return { email, userId: await seedPerson(db(), email, 'admin') };
}

function pageEvent(cookies: CookieJar): RequestEvent {
  return requestEvent(`${ORIGIN}/auth/security`, {
    cookies,
    clientAddress: '203.0.113.3'
  });
}

/** The security page signed in for `email`, an admin without a second factor yet. */
async function openPage(email: string): Promise<CookieJar> {
  const cookies = cookieJar();
  const outcome = await securitySignIn(pageEvent(cookies), {
    email,
    _password: PASSWORD,
    action: 'password'
  }).catch((err: unknown) => err);
  expect(isRedirect(outcome)).toBe(true);
  return cookies;
}

function manage(
  cookies: CookieJar,
  fields: Partial<ManagePayload> & Pick<ManagePayload, 'action'>
): Promise<ManageResult> {
  return manageSubmit(pageEvent(cookies), {
    code: '',
    passkey: '',
    passkeyName: '',
    ...fields
  });
}

describe('a credential reset between the epoch check and its write (§5.2)', () => {
  it('leaves no session from the token exchange', async () => {
    const { userId } = await seedAdmin();
    const codes = new AuthCodeStore(Date.now);
    const code = codes.issue({
      userId,
      epoch: (await credentialEpoch(db(), userId)) ?? -1,
      clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: pkceS256(VERIFIER),
      scope: ''
    });
    await racedWithReset(userId, async () =>
      tokenEndpoint(
        {
          db: db(),
          jwtSecret: JWT_SECRET,
          codes,
          origin: ORIGIN,
          now: nowIso
        },
        new Request(`${ORIGIN}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            code_verifier: VERIFIER
          })
        })
      )
    );
    expect(await held(userId)).toEqual(NOTHING_HELD);
  });

  it('leaves no authenticator from the sign-in’s enrolment step', async () => {
    const { email, userId } = await seedAdmin();
    const pending = cookieJar();
    const secret = secretOf(await signIn(pending, email));
    await racedWithReset(userId, async () =>
      submitSecond(pending, {
        code: totpAt(secret, Date.now()),
        action: 'code'
      })
    );
    expect(await held(userId)).toEqual(NOTHING_HELD);
    limiter.loginSucceeded(email);
  });

  it('leaves no authenticator from the security page', async () => {
    const { email, userId } = await seedAdmin();
    const cookies = await openPage(email);
    const secret = secretOf(
      (await manage(cookies, { action: 'totpStart' })).totpSetup
    );
    await racedWithReset(userId, async () =>
      manage(cookies, {
        action: 'totpConfirm',
        code: totpAt(secret, Date.now())
      })
    );
    expect(await held(userId)).toEqual(NOTHING_HELD);
  });

  it('leaves no recovery codes from the security page', async () => {
    const { email, userId } = await seedAdmin();
    const cookies = await openPage(email);
    const secret = secretOf(
      (await manage(cookies, { action: 'totpStart' })).totpSetup
    );
    await manage(cookies, {
      action: 'totpConfirm',
      code: totpAt(secret, Date.now())
    });
    // Past the page's check, the window is between the read of the user's methods and the
    // codes' write.
    await racedWithReset(
      userId,
      async () => manage(cookies, { action: 'codes' }),
      'totp_credentials'
    );
    expect(await held(userId)).toEqual(NOTHING_HELD);
  });

  async function createWithHeldToken(table: string): Promise<void> {
    const { userId } = await seedAdmin();
    const { raw, tokenHash } = newPersonalAccessToken();
    await db()
      .insertInto('personalAccessTokens')
      .values({
        id: newId(),
        userId,
        name: 'held',
        tokenHash,
        createdBy: userId,
        createdAt: nowIso(),
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null
      })
      .execute();
    await racedWithReset(
      userId,
      async () => {
        const auth = await authenticateToken(
          { db: db(), jwtSecret: JWT_SECRET },
          raw
        );
        if (auth === null) {
          throw new Error('the token was revoked when presented');
        }
        return runOperation(
          db(),
          'personalAccessTokens.create',
          { userId, name: 'created' },
          {
            actor: auth.actor,
            channel: 'rest',
            requestId: newId(),
            credentialEpoch: auth.credentialEpoch
          }
        );
      },
      table
    );
    expect(await held(userId)).toEqual(NOTHING_HELD);
  }

  it('leaves no personal access token created with a token the reset revokes', async () => {
    await createWithHeldToken('users');
  });

  // The reset between the read of the presented token and the read of its user's epoch: the
  // request may not carry the epoch the reset set.
  it('leaves no personal access token when the reset follows the token’s read', async () => {
    await createWithHeldToken('personal_access_tokens');
  });
});
