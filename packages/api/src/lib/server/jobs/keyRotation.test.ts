import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { decrypt, encrypt, keyringFromEnv } from '../secretbox.js';
import { reencryptSweep } from './keyRotation.js';

const KEY_BYTE_LENGTH = 32;
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const silentLog = pino({ enabled: false });

/** A valid `SECRETBOX_KEY`-shaped value for `generation`, with a fresh random key. */
function keySpec(generation: number): string {
  return `${generation}:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;
}

async function migratedDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  return db;
}

async function insertWebhook(
  db: Db,
  id: string,
  secretEnc: Buffer
): Promise<void> {
  await sql`
    INSERT INTO webhooks (id, url, secret_enc, created_at)
    VALUES (${id}, 'https://example.test/hook', ${secretEnc}, ${CREATED_AT})
  `.execute(db);
}

describe('reencryptSweep', () => {
  it('re-encrypts a row written under the previous generation', async () => {
    const db = await migratedDb();
    const previousSpec = keySpec(1);
    const previousRing = keyringFromEnv({ SECRETBOX_KEY: previousSpec });
    await insertWebhook(db, 'wh1', encrypt(previousRing, 'shh'));

    const currentRing = keyringFromEnv({
      SECRETBOX_KEY: keySpec(2),
      SECRETBOX_KEY_PREVIOUS: previousSpec
    });
    const result = await reencryptSweep(db, currentRing, silentLog);
    expect(result).toEqual({ reencrypted: 1, remaining: 0 });

    const { rows } = await sql<{
      secretEnc: Buffer;
    }>`SELECT secret_enc AS secretEnc FROM webhooks WHERE id = 'wh1'`.execute(
      db
    );
    const [row] = rows;
    if (row === undefined) {
      throw new Error('keyRotation test: expected a row for wh1');
    }
    expect(decrypt(currentRing, row.secretEnc).toString('utf8')).toBe('shh');
  });

  it('counts a blob under a generation the keyring does not hold as remaining', async () => {
    const db = await migratedDb();
    const staleRing = keyringFromEnv({ SECRETBOX_KEY: keySpec(0) });
    const staleBlob = encrypt(staleRing, 'stuck');
    await insertWebhook(db, 'wh2', staleBlob);

    const currentRing = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const result = await reencryptSweep(db, currentRing, silentLog);
    expect(result).toEqual({ reencrypted: 0, remaining: 1 });

    const { rows } = await sql<{
      secretEnc: Buffer;
    }>`SELECT secret_enc AS secretEnc FROM webhooks WHERE id = 'wh2'`.execute(
      db
    );
    const [row] = rows;
    if (row === undefined) {
      throw new Error('keyRotation test: expected a row for wh2');
    }
    expect(row.secretEnc).toEqual(staleBlob);
  });

  it('counts a zero-length blob as remaining instead of throwing', async () => {
    const db = await migratedDb();
    await insertWebhook(db, 'wh3', Buffer.alloc(0));

    const currentRing = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const result = await reencryptSweep(db, currentRing, silentLog);
    expect(result).toEqual({ reencrypted: 0, remaining: 1 });
  });

  it('counts a corrupt blob on the current generation as remaining instead of skipping it', async () => {
    const db = await migratedDb();
    const currentSpec = keySpec(1);
    const currentRing = keyringFromEnv({ SECRETBOX_KEY: currentSpec });
    const goodBlob = encrypt(currentRing, 'shh');
    const corruptBlob = Buffer.from(goodBlob);
    const lastByteIndex = corruptBlob.length - 1;
    const BYTE_MODULUS = 256;
    const lastByte = corruptBlob[lastByteIndex];
    if (lastByte === undefined) {
      throw new Error('keyRotation test: empty blob');
    }
    corruptBlob[lastByteIndex] = (lastByte + 1) % BYTE_MODULUS;
    await insertWebhook(db, 'wh4', corruptBlob);

    const result = await reencryptSweep(db, currentRing, silentLog);
    expect(result).toEqual({ reencrypted: 0, remaining: 1 });
  });
});
