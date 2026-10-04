import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { decrypt, encrypt, type Keyring } from '#lib/server/secretbox.js';

import { OpError } from '../types.js';

const CREDENTIALS = [
  'username',
  'password',
  'accessKeyId',
  'secretAccessKey'
] as const;
type Credential = (typeof CREDENTIALS)[number];

/** The backend credentials each target kind takes beside the restic password (§6.5). */
const CREDENTIALS_BY_KIND: Record<string, readonly Credential[]> = {
  local: [],
  s3: ['accessKeyId', 'secretAccessKey'],
  sftp: ['username', 'password'],
  ftp: ['username', 'password'],
  ftps: ['username', 'password'],
  webdav: ['username', 'password']
};

const credential = z.string().min(1);

// The sftp username is a word of the ssh command restic runs (jobs/backupBackends.ts): a leading
// `-` would read as an option, and whitespace, a quote or a backslash would split the word.
const UNSAFE_SFTP_USERNAME_PATTERN = /^-|[\s"'\\]/u;

/** A target's secret, as `secret_enc` holds it in JSON (§6.5, §11.2): write-only. */
export const targetSecretSchema = z
  .object({
    resticPassword: credential,
    username: credential.optional(),
    password: credential.optional(),
    accessKeyId: credential.optional(),
    secretAccessKey: credential.optional()
  })
  .strict()
  .describe(
    "The restic repository password and the kind's backend credentials: { resticPassword } for local, { resticPassword, username, password } for sftp, ftp, ftps and webdav, { resticPassword, accessKeyId, secretAccessKey } for s3; write-only, read as secretSet; required, so null is refused."
  );

export type BackupSecret = z.infer<typeof targetSecretSchema>;

/**
 * Throws 422 unless `secret` carries exactly the backend credentials a `kind` target takes, and
 * an sftp username can be passed to ssh as one argument.
 */
export function assertSecretFitsKind(kind: string, secret: BackupSecret): void {
  const wanted = CREDENTIALS_BY_KIND[kind] ?? [];
  const fits = CREDENTIALS.every(
    field => wanted.includes(field) === (secret[field] !== undefined)
  );
  if (!fits) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `backups: the secret of a '${kind}' target is { ${['resticPassword', ...wanted].join(', ')} }`
    );
  }
  if (
    kind === 'sftp' &&
    UNSAFE_SFTP_USERNAME_PATTERN.test(secret.username ?? '')
  ) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'backups: an sftp username cannot begin with - or contain whitespace, a quote or a backslash'
    );
  }
}

/** `secret` encrypted for `secret_enc`. */
export function sealTargetSecret(kr: Keyring, secret: BackupSecret): Buffer {
  return encrypt(kr, JSON.stringify(secret));
}

/** The secret `secret_enc` holds; throws on anything but the JSON `sealTargetSecret` wrote. */
export function openTargetSecret(kr: Keyring, secretEnc: Buffer): BackupSecret {
  return targetSecretSchema.parse(
    JSON.parse(decrypt(kr, secretEnc).toString('utf8'))
  );
}
