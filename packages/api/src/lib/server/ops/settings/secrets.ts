import { encrypt, keyringFromEnv } from '$lib/server/secretbox.js';

import { recordChange } from '../runner.js';
import type { Context } from '../types.js';

type SecretField = 'smtpPassword' | 'ssoClientSecret' | 'ringotelApiToken';

/** The column `secretbox` encrypts each wire secret field into (§5.4, §11.4). */
const SECRET_COLUMNS: Record<SecretField, string> = {
  smtpPassword: 'smtpPasswordEnc',
  ssoClientSecret: 'ssoClientSecretEnc',
  ringotelApiToken: 'ringotelApiTokenEnc'
};

/** Encrypts every `SECRET_COLUMNS` field present in `input`; masked in the audit diff (§5.4). */
export function applySecretFields(
  ctx: Context,
  input: Record<string, unknown>,
  columns: Record<string, unknown>
): void {
  const present = (Object.keys(SECRET_COLUMNS) as SecretField[]).filter(
    field => field in input
  );
  if (present.length === 0) {
    return;
  }
  const keyring = keyringFromEnv(process.env);
  for (const field of present) {
    const value = input[field] as string | null;
    recordChange(ctx, { field, from: null, to: value });
    columns[SECRET_COLUMNS[field]] =
      value === null ? null : encrypt(keyring, value);
  }
}
