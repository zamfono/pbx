/**
 * What a credential reset ends (§5.2, §5.9): a redeemed password reset, either link, an MFA reset,
 * through the operation or the host command's shared `resetMfa`, and the soft delete. Each ends
 * the security page's session and every sign-in in flight through `users.credential_epoch`, and
 * the personal access tokens the user holds, not those they created for others.
 */
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import * as privateEnv from '$app/env/private';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  credentialEpoch,
  epochSeconds,
  newId,
  nowIso,
  resetMfa,
  type Db
} from '@zamfono/shared';
import {
  migrateForTest,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import {
  authenticateLink,
  authenticateToken
} from '#lib/server/auth/bearer.js';
import { encodeMetadataClientId } from '#lib/server/auth/clients.js';
import { AuthCodeStore } from '#lib/server/auth/codes.js';
import { CONSENT_COOKIE } from '#lib/server/auth/consent.js';
import { encodeLinkToken } from '#lib/server/auth/jwt.js';
import { totpAt } from '#lib/server/auth/mfa/totp.js';
import { redeemPasswordReset } from '#lib/server/auth/passwordReset.js';
import { newPersonalAccessToken } from '#lib/server/auth/personalAccessTokens.js';
import { setSealedCookie } from '#lib/server/auth/sealedCookie.js';
import {
  tokenEndpoint,
  type TokenDeps
} from '#lib/server/auth/tokenEndpoint.js';
import {
  issueResetToken,
  liveResetTokenUser
} from '#lib/server/auth/tokens.js';
import { getDb } from '#lib/server/db.js';
import { pkceS256 } from '#lib/server/hash.js';
import { limiter } from '#lib/server/limiter.js';
import { runOperation } from '#lib/server/ops/runner.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { cookieJar, type CookieJar } from '#testing/requestEvent.js';
import {
  eventFor,
  ORIGIN,
  PASSWORD,
  secretOf,
  seedPerson,
  signIn,
  submitSecond
} from '#testing/signInKit.js';
import { asConfirmedRun, asRun, owner } from '#testing/testDb.js';

import { approveConsentSubmit } from '../oauth/authorize/consentSubmit.js';
import { signedIn } from './security/securityAccount.js';
import { securitySignIn } from './security/securitySignIn.js';

import '#lib/server/ops/audit/index.js';
import '#lib/server/ops/users/index.js';

vi.mock('#lib/server/mail/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#lib/server/mail/index.js')>()),
  sendMail: vi.fn(() => Promise.resolve('sent'))
}));

const KEY_BYTE_LENGTH = 32;
const JWT_SECRET = 'credential-epoch-secret';
const NEW_PASSWORD = 'a brand new password';
const REDIRECT_URI = 'https://client.example.com/callback';
const VERIFIER = 'a-code-verifier-of-enough-length';
const CHALLENGE = pkceS256(VERIFIER);
const AUDIO_PATH = '/api/v1/voicemails/vm1/audio';
const LINK_TTL_S = 300;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

process.env.DB_FILE = ':memory:';
process.env.FQDN = 'pbx.example.com';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

let clientId = '';

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await seedSettings(db, { companyName: 'Acme', language: 'en' });
  await seedUser(db, {
    id: owner.id,
    name: owner.name,
    email: 'owner@x',
    role: owner.role,
    passwordHash: 'x'
  });
  clientId = encodeMetadataClientId(keyringFromEnv(privateEnv), {
    name: 'Test Client',
    redirectUris: [REDIRECT_URI],
    applicationType: 'web'
  });
  await db
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

/** The token of set-password link `link`. */
function tokenOf(link: string): string {
  return new URL(link).searchParams.get('token') ?? '';
}

/** Redeems `token` for `NEW_PASSWORD`, which must succeed. */
async function redeem(db: Db, token: string): Promise<string> {
  expect(
    await redeemPasswordReset(db, { token, password: NEW_PASSWORD })
  ).toEqual({ kind: 'passwordSet' });
  return NEW_PASSWORD;
}

/** A credential reset of `userId`, answering the password a sign-in uses after it (`null` once
 *  no sign-in can follow). */
type Reset = {
  name: string;
  run: (db: Db, userId: string) => Promise<string | null>;
};

const RESETS: Reset[] = [
  {
    name: 'a redeemed forgot-password link',
    run: async (db, userId) =>
      redeem(db, (await issueResetToken(db, userId, 'reset', nowIso())).raw)
  },
  {
    name: 'a redeemed users.resetPassword link',
    run: async (db, userId) => {
      const { link } = (await runOperation(
        db,
        'users.resetPassword',
        { id: userId },
        asRun()
      )) as { link: string };
      return redeem(db, tokenOf(link));
    }
  },
  {
    name: 'users.resetMfa',
    run: async (db, userId) => {
      await runOperation(
        db,
        'users.resetMfa',
        { id: userId },
        asConfirmedRun()
      );
      return PASSWORD;
    }
  },
  {
    name: 'the shared resetMfa, as reset-mfa.mjs runs it in another process',
    run: async (db, userId) => {
      await db
        .transaction()
        .execute(async trx => resetMfa(trx, userId, nowIso()));
      return PASSWORD;
    }
  },
  {
    name: 'the soft delete',
    run: async (db, userId) => {
      await runOperation(db, 'users.delete', { id: userId }, asConfirmedRun());
      return null;
    }
  }
];

/** Opens the security page for `email` with `password`: an admin without a second factor yet
 *  signs in with the password alone. */
async function openSecurityPage(
  email: string,
  password: string
): Promise<CookieJar> {
  const cookies = cookieJar();
  const outcome = await securitySignIn(eventFor(cookies), {
    email,
    _password: password,
    action: 'password'
  }).catch((err: unknown) => err);
  expect(isRedirect(outcome)).toBe(true);
  return cookies;
}

/** A consent cookie for `userId` at `epoch`, as `completeLogin` seals it. */
function sealedConsent(userId: string, epoch: number): string {
  const cookies = cookieJar();
  setSealedCookie(cookies, keyringFromEnv(privateEnv), CONSENT_COOKIE, {
    userId,
    epoch,
    clientName: 'Test Client',
    authorize: {
      clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
      scope: '',
      state: 'state-1'
    }
  });
  return cookies.get(CONSENT_COOKIE.name) ?? '';
}

/** The approve button pressed with consent cookie `sealed`: what it threw. */
async function approve(sealed: string): Promise<unknown> {
  const cookies = cookieJar();
  cookies.set(CONSENT_COOKIE.name, sealed, { path: '/' });
  return approveConsentSubmit(eventFor(cookies), {
    client_id: clientId,
    code_challenge: CHALLENGE
  }).catch((err: unknown) => err);
}

/** The token endpoint's status for authorization code `code`. */
async function exchange(codes: AuthCodeStore, code: string): Promise<number> {
  const deps: TokenDeps = {
    db: getDb(),
    jwtSecret: JWT_SECRET,
    codes,
    origin: ORIGIN,
    now: nowIso
  };
  const response = await tokenEndpoint(
    deps,
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
  );
  return response.status;
}

/** An MCP download link of `userId` at `epoch`. */
async function downloadLink(userId: string, epoch: number): Promise<URL> {
  const nowS = epochSeconds(Date.now());
  const token = await encodeLinkToken(JWT_SECRET, 'download', {
    sub: userId,
    cid: null,
    ep: epoch,
    aud: AUDIO_PATH,
    iat: nowS,
    exp: nowS + LINK_TTL_S
  });
  return new URL(`${ORIGIN}${AUDIO_PATH}?access_token=${token}`);
}

/** A personal access token held by `userId`, created by `createdBy`. */
async function seedPat(
  db: Db,
  userId: string,
  createdBy: string
): Promise<string> {
  const { raw, tokenHash } = newPersonalAccessToken();
  await db
    .insertInto('personalAccessTokens')
    .values({
      id: newId(),
      userId,
      name: `pat-${randomBytes(4).toString('hex')}`,
      tokenHash,
      createdBy,
      createdAt: nowIso(),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null
    })
    .execute();
  return raw;
}

describe.each(RESETS)('$name', reset => {
  it('ends every sign-in issued before it and the tokens the user holds, and a sign-in after it works', async () => {
    const db = getDb();
    const tag = randomBytes(4).toString('hex');
    const email = `admin-${tag}@example.com`;
    const userId = await seedPerson(db, email, 'admin');
    const other = await seedUser(db, {
      name: 'Ben',
      email: `ben-${tag}@example.com`
    });
    const bearer = { db, jwtSecret: JWT_SECRET };
    const before = await credentialEpoch(db, userId);
    if (before === null) {
      throw new Error('the user is live');
    }

    // Issued before the reset: the security page's session, a pending second-factor login (an
    // admin without a method is at enrolment), a consent cookie that has minted a code already
    // and is replayed, an authorization code and an MCP link.
    const security = await openSecurityPage(email, PASSWORD);
    expect(await signedIn(eventFor(security))).not.toBeNull();
    const pending = cookieJar();
    const secret = secretOf(await signIn(pending, email));
    const sealed = sealedConsent(userId, before);
    expect(isRedirect(await approve(sealed))).toBe(true);
    const codes = new AuthCodeStore(Date.now);
    const issue = (epoch: number): string =>
      codes.issue({
        userId,
        epoch,
        clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: CHALLENGE,
        scope: ''
      });
    const code = issue(before);
    const link = await downloadLink(userId, before);
    expect(await authenticateLink(bearer, 'download', link)).not.toBeNull();
    const ownPat = await seedPat(db, userId, userId);
    const othersPat = await seedPat(db, other, userId);

    const password = await reset.run(db, userId);

    expect(await signedIn(eventFor(security))).toBeNull();
    const enrolled = await submitSecond(pending, {
      code: totpAt(secret, Date.now()),
      action: 'code'
    }).catch((err: unknown) => err);
    expect(isHttpError(enrolled, HTTP_BAD_REQUEST)).toBe(true);
    expect(isHttpError(await approve(sealed), HTTP_BAD_REQUEST)).toBe(true);
    expect(await exchange(codes, code)).toBe(HTTP_BAD_REQUEST);
    expect(await authenticateLink(bearer, 'download', link)).toBeNull();
    expect(await authenticateToken(bearer, ownPat)).toBeNull();
    expect(await authenticateToken(bearer, othersPat)).toMatchObject({
      actor: { id: other }
    });

    const after = await db
      .selectFrom('users')
      .select('credentialEpoch')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(after.credentialEpoch).toBe(before + 1);
    if (password === null) {
      return;
    }
    limiter.loginSucceeded(email);
    expect(
      await signedIn(eventFor(await openSecurityPage(email, password)))
    ).not.toBeNull();
    expect(await exchange(codes, issue(after.credentialEpoch))).toBe(HTTP_OK);
    expect(
      await authenticateLink(
        bearer,
        'download',
        await downloadLink(userId, after.credentialEpoch)
      )
    ).not.toBeNull();
  });
});

describe('the soft delete of a user (§5.9)', () => {
  it('revokes their setup and reset links and ends their sign-ins, which stay ended after an undo', async () => {
    const db = getDb();
    const userId = await seedPerson(db, 'carla@example.com', 'user');
    const setup = await issueResetToken(db, userId, 'setup', nowIso());
    const resetLink = await issueResetToken(db, userId, 'reset', nowIso());
    const codes = new AuthCodeStore(Date.now);
    const code = codes.issue({
      userId,
      epoch: (await credentialEpoch(db, userId)) ?? -1,
      clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
      scope: ''
    });
    await runOperation(db, 'users.delete', { id: userId }, asConfirmedRun());
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'users.delete')
      .where('entityId', '=', userId)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());
    for (const { raw } of [setup, resetLink]) {
      // eslint-disable-next-line no-await-in-loop -- one link after the other
      expect(await liveResetTokenUser(db, raw, nowIso())).toBeNull();
    }
    expect(await exchange(codes, code)).toBe(HTTP_BAD_REQUEST);
  });
});
