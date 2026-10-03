import { sql } from 'kysely';
import type { Logger } from 'pino';

import type { Db } from '@zamfono/shared';

import { decrypt, encrypt, type Keyring } from '../secretbox.js';

// §5.4: every `*_enc` column the boot sweep re-encrypts, by table.
export const ENC_COLUMNS: Record<string, readonly string[]> = {
  devices: ['sip_password_enc'],
  trunks: ['password_enc'],
  webhooks: ['secret_enc'],
  backup_targets: ['secret_enc'],
  settings: [
    'smtp_password_enc',
    'sso_client_secret_enc',
    'ringotel_api_token_enc'
  ]
};

type SweepResult = { reencrypted: number; remaining: number };

/** Decrypts `blob`, or `null` when its key generation is unreadable by `kr`. */
function tryDecrypt(kr: Keyring, blob: Buffer): Buffer | null {
  try {
    return decrypt(kr, blob);
  } catch {
    return null;
  }
}

/**
 * Re-encrypts every blob in `table.column` still on the keyring's previous generation.
 * A blob on the current generation is left alone; a blob on neither generation is a
 * secret nobody can read and is counted as `remaining`.
 */
async function reencryptColumn(
  db: Db,
  kr: Keyring,
  table: string,
  column: string
): Promise<SweepResult> {
  const { rows } = await sql<{
    id: string | number;
    blob: Buffer;
  }>`SELECT id, ${sql.ref(column)} AS blob FROM ${sql.table(table)} WHERE ${sql.ref(column)} IS NOT NULL`.execute(
    db
  );

  let reencrypted = 0;
  let remaining = 0;
  for (const row of rows) {
    if (row.blob.length === 0) {
      remaining += 1;
      continue;
    }
    const plain = tryDecrypt(kr, row.blob);
    if (plain === null) {
      remaining += 1;
      continue;
    }
    if (row.blob.readUInt8(0) === kr.current.generation) {
      continue;
    }
    const reencryptedBlob = encrypt(kr, plain);
    // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; updates must serialize
    await sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${reencryptedBlob} WHERE id = ${row.id}`.execute(
      db
    );
    reencrypted += 1;
  }
  return { reencrypted, remaining };
}

/**
 * Walks every `*_enc` column in `ENC_COLUMNS`, re-encrypting each blob still on the
 * keyring's previous generation, and logs `key rotation: {n} re-encrypted, {m} remaining` (§5.4).
 */
export async function reencryptSweep(
  db: Db,
  kr: Keyring,
  log: Logger
): Promise<SweepResult> {
  let reencrypted = 0;
  let remaining = 0;
  for (const [table, columns] of Object.entries(ENC_COLUMNS)) {
    for (const column of columns) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; sweeps must serialize
      const result = await reencryptColumn(db, kr, table, column);
      reencrypted += result.reencrypted;
      remaining += result.remaining;
    }
  }
  log.info(`key rotation: ${reencrypted} re-encrypted, ${remaining} remaining`);
  return { reencrypted, remaining };
}
