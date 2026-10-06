import type { Logger } from 'pino';

import type { DB, Db } from '@zamfono/shared';

import { decrypt, encrypt, type Keyring } from '../secretbox.js';

type EncTable =
  | 'backupTargets'
  | 'devices'
  | 'settings'
  | 'totpCredentials'
  | 'trunks'
  | 'webhooks';
type EncColumn<T extends EncTable> = Extract<keyof DB[T], `${string}Enc`>;
type AnyEncColumn = { [T in EncTable]: EncColumn<T> }[EncTable];

// §5.4: every `*_enc` column the boot sweep re-encrypts, by table.
const ENC_COLUMNS: readonly {
  [T in EncTable]: { table: T; columns: readonly EncColumn<T>[] };
}[EncTable][] = [
  { table: 'backupTargets', columns: ['secretEnc'] },
  { table: 'devices', columns: ['sipPasswordEnc'] },
  {
    table: 'settings',
    columns: ['ringotelApiTokenEnc', 'smtpPasswordEnc', 'ssoClientSecretEnc']
  },
  { table: 'totpCredentials', columns: ['secretEnc'] },
  { table: 'trunks', columns: ['passwordEnc'] },
  { table: 'webhooks', columns: ['secretEnc'] }
];

/** One stored blob and the row and column it lives in. */
type EncBlob = {
  table: EncTable;
  column: AnyEncColumn;
  id: string | number | null;
  blob: Buffer;
};

/** Every non-null blob in `table.column`. */
async function readColumn(
  db: Db,
  table: EncTable,
  column: AnyEncColumn
): Promise<EncBlob[]> {
  const ref = db.dynamic.ref<AnyEncColumn>(column);
  const rows = await db
    .selectFrom(table)
    .select(['id', ref])
    .where(ref, 'is not', null)
    .execute();
  return rows.flatMap(row => {
    const blob = row[column];
    return blob ? [{ table, column, id: row.id, blob }] : [];
  });
}

/** Every non-null blob in every `*_enc` column (§5.4). */
async function readEncBlobs(db: Db): Promise<EncBlob[]> {
  const columns = ENC_COLUMNS.flatMap(({ table, columns: names }) =>
    names.map(column => readColumn(db, table, column))
  );
  return (await Promise.all(columns)).flat();
}

/** `blob`'s plaintext, or `null` when the keyring cannot decrypt it. */
function tryDecrypt(kr: Keyring, entry: EncBlob): Buffer | null {
  try {
    return decrypt(kr, `${entry.table}.${entry.column}`, entry.blob);
  } catch {
    return null;
  }
}

/**
 * Whether `blob` is still to be brought forward or lost (§5.4): anything the keyring's current
 * key cannot decrypt. The one definition of "remaining" the sweep logs and `/healthz` reports.
 */
function isRemaining(kr: Keyring, entry: EncBlob): boolean {
  return (
    tryDecrypt(kr, entry) === null ||
    entry.blob.readUInt8(0) !== kr.current.generation
  );
}

/**
 * Blobs the keyring's current key cannot decrypt (§5.4): those the boot sweep has not brought
 * forward yet and those no key the keyring holds can read. Read-only, so a `/healthz` request
 * never itself re-encrypts anything.
 */
export async function countKeyRotationRemaining(
  db: Db,
  kr: Keyring
): Promise<number> {
  const blobs = await readEncBlobs(db);
  return blobs.filter(entry => isRemaining(kr, entry)).length;
}

/**
 * Re-encrypts every blob still on the keyring's previous generation under the current key and
 * logs `key rotation: {n} re-encrypted, {m} remaining` (§5.4), `m` counting as
 * `countKeyRotationRemaining` does once the sweep is done.
 */
export async function reencryptSweep(
  db: Db,
  kr: Keyring,
  log: Logger
): Promise<{ reencrypted: number; remaining: number }> {
  const stale = (await readEncBlobs(db)).filter(entry =>
    isRemaining(kr, entry)
  );
  const readable = stale.flatMap(entry => {
    const plain = tryDecrypt(kr, entry);
    return plain === null ? [] : [{ ...entry, plain }];
  });
  await Promise.all(
    readable.map(({ table, column, id, plain }) =>
      db
        .updateTable(table)
        .set(db.dynamic.ref(column), encrypt(kr, `${table}.${column}`, plain))
        .where('id', '=', id)
        .execute()
    )
  );
  const reencrypted = readable.length;
  const remaining = stale.length - reencrypted;
  log.info(`key rotation: ${reencrypted} re-encrypted, ${remaining} remaining`);
  return { reencrypted, remaining };
}
