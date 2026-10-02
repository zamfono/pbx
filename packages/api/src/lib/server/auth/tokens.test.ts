import { describe, expect, it } from 'vitest';

import { MS_PER_DAY, MS_PER_HOUR, type Db } from '@zamfono/shared';

import { makeTestDb } from '../testDb.js';
import { upsertClient } from './clients.js';
import {
  hashToken,
  issueRefresh,
  issueResetToken,
  redeemResetToken,
  revokeUserTokens,
  rotateRefresh
} from './tokens.js';

const NOW = '2026-01-01T00:00:00.000Z';

function afterMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/** `tokens.client_id` is a real FK into `oauth_clients` (§11.2); tests seed the row it needs. */
async function seedClient(db: Db, clientId: string): Promise<void> {
  await upsertClient(
    db,
    {
      clientId,
      kind: 'metadata',
      name: 'Test client',
      redirectUris: ['https://client.test/callback'],
      applicationType: 'native'
    },
    NOW
  );
}

describe('hashToken', () => {
  it('is the sha256 hex digest of the raw token', () => {
    expect(hashToken('raw')).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('issueRefresh / rotateRefresh', () => {
  it('issues a refresh token valid for 30 days', async () => {
    const db = await makeTestDb();
    await seedClient(db, 'client-1');
    const issued = await issueRefresh(db, 'owner', 'client-1', NOW);
    expect(issued.expiresAt).toBe(afterMs(NOW, 30 * MS_PER_DAY));
  });

  it('rotates a live token, returning a new one', async () => {
    const db = await makeTestDb();
    await seedClient(db, 'client-1');
    const issued = await issueRefresh(db, 'owner', 'client-1', NOW);
    const later = afterMs(NOW, 1000);
    const rotated = await rotateRefresh(db, issued.raw, later);
    expect(rotated).toMatchObject({
      ok: true,
      userId: 'owner',
      clientId: 'client-1'
    });
  });

  it('refuses an unknown refresh token', async () => {
    const db = await makeTestDb();
    expect(await rotateRefresh(db, 'never-issued', NOW)).toEqual({
      ok: false,
      reason: 'unknown'
    });
  });

  it('refuses a refresh token past its expiry', async () => {
    const db = await makeTestDb();
    await seedClient(db, 'client-1');
    const issued = await issueRefresh(db, 'owner', 'client-1', NOW);
    const past = afterMs(NOW, 30 * MS_PER_DAY + 1);
    expect(await rotateRefresh(db, issued.raw, past)).toEqual({
      ok: false,
      reason: 'expired'
    });
  });

  it('treats a replay of an already-rotated token as replayed, and revokes the pair', async () => {
    const db = await makeTestDb();
    await seedClient(db, 'client-1');
    const first = await issueRefresh(db, 'owner', 'client-1', NOW);
    const second = await issueRefresh(db, 'owner', 'client-1', NOW);
    const later = afterMs(NOW, 1000);
    await rotateRefresh(db, first.raw, later);
    const replay = await rotateRefresh(db, first.raw, later);
    expect(replay).toEqual({ ok: false, reason: 'replayed' });
    const secondRow = await db
      .selectFrom('tokens')
      .select('revokedAt')
      .where('tokenHash', '=', hashToken(second.raw))
      .executeTakeFirstOrThrow();
    expect(secondRow.revokedAt).not.toBeNull();
  });

  it('refuses a rotated token presented after its expiry as expired, without revoking the pair', async () => {
    const db = await makeTestDb();
    await seedClient(db, 'client-1');
    const first = await issueRefresh(db, 'owner', 'client-1', NOW);
    const rotated = await rotateRefresh(db, first.raw, afterMs(NOW, 1000));
    if (!rotated.ok) {
      throw new Error('expected the first rotation to succeed');
    }
    // The purge keeps an expired refresh row 30 more days (§5.2 "Client rows"); it is past
    // the replay window then, so presenting it must not end the live session.
    const pastExpiry = afterMs(NOW, 30 * MS_PER_DAY + 1);
    expect(await rotateRefresh(db, first.raw, pastExpiry)).toEqual({
      ok: false,
      reason: 'expired'
    });
    const nextRow = await db
      .selectFrom('tokens')
      .select('revokedAt')
      .where('tokenHash', '=', hashToken(rotated.next.raw))
      .executeTakeFirstOrThrow();
    expect(nextRow.revokedAt).toBeNull();
  });
});

describe('revokeUserTokens', () => {
  it('revokes only the tokens of the given client when one is named', async () => {
    const db = await makeTestDb();
    await seedClient(db, 'client-a');
    await seedClient(db, 'client-b');
    const forA = await issueRefresh(db, 'owner', 'client-a', NOW);
    const forB = await issueRefresh(db, 'owner', 'client-b', NOW);
    await revokeUserTokens(db, 'owner', NOW, 'client-a');
    const rowA = await db
      .selectFrom('tokens')
      .select('revokedAt')
      .where('tokenHash', '=', hashToken(forA.raw))
      .executeTakeFirstOrThrow();
    const rowB = await db
      .selectFrom('tokens')
      .select('revokedAt')
      .where('tokenHash', '=', hashToken(forB.raw))
      .executeTakeFirstOrThrow();
    expect(rowA.revokedAt).not.toBeNull();
    expect(rowB.revokedAt).toBeNull();
  });
});

describe('issueResetToken / redeemResetToken', () => {
  it('gives a setup link 7 days and a reset link 1 hour', async () => {
    const db = await makeTestDb();
    const setup = await issueResetToken(db, 'owner', 'setup', NOW);
    const reset = await issueResetToken(db, 'owner', 'reset', NOW);
    expect(setup.expiresAt).toBe(afterMs(NOW, 7 * MS_PER_DAY));
    expect(reset.expiresAt).toBe(afterMs(NOW, MS_PER_HOUR));
  });

  it('redeems a token once; a second redemption fails', async () => {
    const db = await makeTestDb();
    const { raw } = await issueResetToken(db, 'owner', 'reset', NOW);
    expect(await redeemResetToken(db, raw, NOW)).toEqual({
      ok: true,
      userId: 'owner'
    });
    expect(await redeemResetToken(db, raw, NOW)).toEqual({ ok: false });
  });

  it('refuses a token past its expiry', async () => {
    const db = await makeTestDb();
    const { raw } = await issueResetToken(db, 'owner', 'reset', NOW);
    const past = afterMs(NOW, MS_PER_HOUR + 1);
    expect(await redeemResetToken(db, raw, past)).toEqual({ ok: false });
  });
});
