import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';

import { makeTestDb, owner } from '#testing/testDb.js';

import { provideEventSink } from '../eventSink.js';
import { AuthCodeStore } from './codes.js';
import { revokeEndpoint } from './oauth.js';
import { redeemPasswordReset } from './passwordReset.js';
import { tokenEndpoint } from './tokenEndpoint.js';
import { issueRefresh, issueResetToken, type IssuedRefresh } from './tokens.js';

const ORIGIN = 'https://pbx.example.com';

/**
 * §10.6: every path that revokes a session outside an operation has the `/events` sockets checked
 * again, as the runner does after a committed write, so a revoked session's sockets close.
 */
describe('a session revoked outside an operation', () => {
  const usersChanged = vi.fn();

  beforeEach(() => {
    usersChanged.mockClear();
    provideEventSink({ publish: vi.fn(), usersChanged });
  });

  async function session(): Promise<{ db: Db; refresh: IssuedRefresh }> {
    const db = await makeTestDb();
    await db
      .insertInto('oauthClients')
      .values({
        clientId: 'client-1',
        name: 'Ops Console',
        kind: 'cimd',
        createdAt: nowIso(),
        lastLoginAt: nowIso()
      })
      .execute();
    const refresh = await issueRefresh(db, owner.id, 'client-1', nowIso());
    return { db, refresh };
  }

  function refreshGrant(db: Db, raw: string): Promise<Response> {
    return tokenEndpoint(
      {
        db,
        jwtSecret: 'test-secret',
        codes: new AuthCodeStore(Date.now),
        origin: ORIGIN,
        now: nowIso
      },
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: raw
        })
      })
    );
  }

  it('by /oauth/revoke', async () => {
    const { db, refresh } = await session();
    await revokeEndpoint(
      { db, now: nowIso },
      new Request(`${ORIGIN}/oauth/revoke`, {
        method: 'POST',
        body: new URLSearchParams({ token: refresh.raw })
      })
    );
    expect(usersChanged).toHaveBeenCalledOnce();
  });

  it('by a replayed refresh token, and not by a rotation', async () => {
    const { db, refresh } = await session();
    expect((await refreshGrant(db, refresh.raw)).status).toBe(200);
    expect(usersChanged).not.toHaveBeenCalled();
    expect((await refreshGrant(db, refresh.raw)).status).toBe(400);
    expect(usersChanged).toHaveBeenCalledOnce();
  });

  it('by a password reset', async () => {
    const { db } = await session();
    const { raw } = await issueResetToken(db, owner.id, 'reset', nowIso());
    expect(
      await redeemPasswordReset(db, {
        token: raw,
        password: 'a brand new password'
      })
    ).toEqual({ kind: 'passwordSet' });
    expect(usersChanged).toHaveBeenCalledOnce();
  });
});
