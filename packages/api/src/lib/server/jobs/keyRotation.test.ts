import { sql } from 'kysely';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { keySpec } from '#testing/fixtures.js';

import { decrypt, encrypt, keyringFromEnv } from '../secretbox.js';
import { countKeyRotationRemaining, reencryptSweep } from './keyRotation.js';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const silentLog = pino({ enabled: false });

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
    const db = await migratedTestDb();
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
    const db = await migratedTestDb();
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
    const db = await migratedTestDb();
    await insertWebhook(db, 'wh3', Buffer.alloc(0));

    const currentRing = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const result = await reencryptSweep(db, currentRing, silentLog);
    expect(result).toEqual({ reencrypted: 0, remaining: 1 });
  });

  it('counts a corrupt blob on the current generation as remaining instead of skipping it', async () => {
    const db = await migratedTestDb();
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

describe('countKeyRotationRemaining', () => {
  it('counts zero when every blob decrypts under the current key', async () => {
    const db = await migratedTestDb();
    const kr = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    await insertWebhook(db, 'wh1', encrypt(kr, 'shh'));
    await expect(countKeyRotationRemaining(db, kr)).resolves.toBe(0);
  });

  it('counts a blob on the previous generation until the sweep re-encrypts it', async () => {
    const db = await migratedTestDb();
    const previousSpec = keySpec(1);
    await insertWebhook(
      db,
      'wh2',
      encrypt(keyringFromEnv({ SECRETBOX_KEY: previousSpec }), 'shh')
    );
    const kr = keyringFromEnv({
      SECRETBOX_KEY: keySpec(2),
      SECRETBOX_KEY_PREVIOUS: previousSpec
    });
    await expect(countKeyRotationRemaining(db, kr)).resolves.toBe(1);
    await reencryptSweep(db, kr, silentLog);
    await expect(countKeyRotationRemaining(db, kr)).resolves.toBe(0);
  });

  it('agrees with the sweep on a blob whose generation byte is current but whose key is not', async () => {
    const db = await migratedTestDb();
    await insertWebhook(
      db,
      'wh3',
      encrypt(keyringFromEnv({ SECRETBOX_KEY: keySpec(1) }), 'lost')
    );
    const kr = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const { remaining } = await reencryptSweep(db, kr, silentLog);
    expect(remaining).toBe(1);
    await expect(countKeyRotationRemaining(db, kr)).resolves.toBe(remaining);
  });
});
