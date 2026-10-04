import { describe, expect, it } from 'vitest';

import { addMsIso, MS_PER_SECOND, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb, owner } from '#testing/testDb.js';

import { purgePersonalAccessTokens } from '../jobs/purgeOauthTokens.js';
import { authenticateRequest, authenticateToken } from './bearer.js';
import {
  livePersonalAccessToken,
  newPersonalAccessToken
} from './personalAccessTokens.js';

const DEPS_SECRET = 'test-secret';
const MCP_AUDIENCE = 'https://pbx.example.com/mcp';
const SECONDS_IN_A_MINUTE = 60;
const GRANT = { id: 'pat-1', expiresAt: null };

type Seeded = { db: Db; raw: string; id: string };

async function seeded(
  columns: { expiresAt?: string | null; revokedAt?: string | null } = {}
): Promise<Seeded> {
  const db = await makeTestDb();
  const { raw, tokenHash } = newPersonalAccessToken();
  await db
    .insertInto('personalAccessTokens')
    .values({
      id: 'pat-1',
      tokenHash,
      userId: owner.id,
      name: 'crm-sync',
      createdBy: owner.id,
      createdAt: nowIso(),
      ...columns
    })
    .execute();
  return { db, raw, id: 'pat-1' };
}

function authenticate(deps: Seeded, token = deps.raw): Promise<unknown> {
  return authenticateToken({ db: deps.db, jwtSecret: DEPS_SECRET }, token);
}

describe('a personal access token as bearer', () => {
  it('acts as its user on REST, MCP and /events alike, with no OAuth client', async () => {
    const deps = await seeded();
    expect(await authenticate(deps)).toEqual({
      actor: owner,
      personalAccessToken: GRANT
    });
    expect(
      await authenticateToken(
        { db: deps.db, jwtSecret: DEPS_SECRET },
        deps.raw,
        MCP_AUDIENCE
      )
    ).toEqual({ actor: owner, personalAccessToken: GRANT });
    const request = new Request(MCP_AUDIENCE, {
      headers: { authorization: `Bearer ${deps.raw}` }
    });
    expect(
      await authenticateRequest(
        { db: deps.db, jwtSecret: DEPS_SECRET },
        request
      )
    ).toEqual({ actor: owner, personalAccessToken: GRANT });
  });

  it('acts with the role its user holds at the request', async () => {
    const deps = await seeded();
    await deps.db
      .updateTable('users')
      .set({ role: 'user' })
      .where('id', '=', owner.id)
      .execute();
    expect(await authenticate(deps)).toEqual({
      actor: { ...owner, role: 'user' },
      personalAccessToken: GRANT
    });
  });

  it('is refused unknown, revoked, expired, or for a soft-deleted user', async () => {
    const live = await seeded({ expiresAt: addMsIso(nowIso(), MS_PER_SECOND) });
    expect(await authenticate(live, `${live.raw}x`)).toBeNull();
    expect(await authenticate(live, 'zpat_unknown')).toBeNull();
    const revoked = await seeded({ revokedAt: nowIso() });
    expect(await authenticate(revoked)).toBeNull();
    const expired = await seeded({ expiresAt: nowIso() });
    expect(await authenticate(expired)).toBeNull();
    await live.db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', owner.id)
      .execute();
    expect(await authenticate(live)).toBeNull();
  });
});

describe('livePersonalAccessToken', () => {
  it('records the last use at most once a minute', async () => {
    const deps = await seeded();
    const lastUsed = async (): Promise<string | null> =>
      (
        await deps.db
          .selectFrom('personalAccessTokens')
          .select('lastUsedAt')
          .executeTakeFirstOrThrow()
      ).lastUsedAt;
    const first = '2026-10-04T10:00:00.000Z';
    expect(await livePersonalAccessToken(deps.db, deps.raw, first)).toEqual({
      ...GRANT,
      userId: owner.id
    });
    expect(await lastUsed()).toBe(first);
    const withinMinute = addMsIso(
      first,
      (SECONDS_IN_A_MINUTE - 1) * MS_PER_SECOND
    );
    await livePersonalAccessToken(deps.db, deps.raw, withinMinute);
    expect(await lastUsed()).toBe(first);
    const minuteLater = addMsIso(first, SECONDS_IN_A_MINUTE * MS_PER_SECOND);
    await livePersonalAccessToken(deps.db, deps.raw, minuteLater);
    expect(await lastUsed()).toBe(minuteLater);
  });
});

describe('purgePersonalAccessTokens', () => {
  it('purges revoked and expired tokens and keeps live ones', async () => {
    const now = nowIso();
    const db = await makeTestDb();
    const rows = [
      { id: 'live', expiresAt: null, revokedAt: null },
      { id: 'later', expiresAt: addMsIso(now, MS_PER_SECOND), revokedAt: null },
      {
        id: 'expired',
        expiresAt: addMsIso(now, -MS_PER_SECOND),
        revokedAt: null
      },
      { id: 'revoked', expiresAt: null, revokedAt: now }
    ];
    await db
      .insertInto('personalAccessTokens')
      .values(
        rows.map(row => ({
          ...row,
          tokenHash: row.id,
          userId: owner.id,
          name: row.id,
          createdAt: now
        }))
      )
      .execute();
    await db.transaction().execute(trx => purgePersonalAccessTokens(trx, now));
    const left = await db
      .selectFrom('personalAccessTokens')
      .select('id')
      .orderBy('id')
      .execute();
    expect(left.map(row => row.id)).toEqual(['later', 'live']);
  });
});
