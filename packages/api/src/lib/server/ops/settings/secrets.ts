import * as env from '$app/env/private';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import { recordChange } from '../audit.js';
import { OpError, type Context } from '../types.js';
import type { SettingsInput } from './_input.js';
import type { SettingsColumns, SettingsRow } from './_shared.js';

type SecretField = 'smtpPassword' | 'ssoClientSecret' | 'ringotelApiToken';

/** The column `secretbox` encrypts each wire secret field into (§5.4, §11.4). */
const SECRET_COLUMNS: Record<
  SecretField,
  Extract<keyof SettingsColumns, `${string}Enc`>
> = {
  smtpPassword: 'smtpPasswordEnc',
  ssoClientSecret: 'ssoClientSecretEnc',
  ringotelApiToken: 'ringotelApiTokenEnc'
};

/** Encrypts every `SECRET_COLUMNS` field present in `input`; masked in the audit diff (§5.4). */
export function applySecretFields(
  ctx: Context,
  input: SettingsInput,
  columns: SettingsColumns
): void {
  const present = (Object.keys(SECRET_COLUMNS) as SecretField[]).filter(
    field => field in input
  );
  if (present.length === 0) {
    return;
  }
  const keyring = keyringFromEnv(env);
  for (const field of present) {
    const value = input[field] ?? null;
    recordChange(ctx, { field, from: null, to: value });
    const column = SECRET_COLUMNS[field];
    Object.assign(columns, {
      [column]:
        value === null ? null : encrypt(keyring, `settings.${column}`, value)
    });
  }
}

type Destinations = Pick<SettingsRow, 'smtpHost' | 'ssoProvider' | 'ssoIssuer'>;

/**
 * Where each secret that leaves the stack is sent, null for nowhere: the mail relay password to
 * `smtpHost`, the SSO client secret to an `oidc` issuer or to Microsoft's or Google's fixed one
 * (§5.2, §10.2). The Ringotel token always goes to Ringotel.
 */
const DESTINATIONS: [SecretField, (row: Destinations) => string | null][] = [
  ['smtpPassword', row => row.smtpHost],
  [
    'ssoClientSecret',
    row =>
      row.ssoProvider === 'oidc' ? `oidc ${row.ssoIssuer}` : row.ssoProvider
  ]
];

/**
 * Throws 422 when `input` sends a stored secret somewhere new without giving it again (§5.4):
 * a new `smtpHost` needs `smtpPassword`, a new SSO issuer `ssoClientSecret`. Clearing the
 * destination, or a port, TLS mode or other field, needs neither.
 */
export function assertSecretsFollowDestinations(
  before: SettingsRow,
  input: SettingsInput
): void {
  const after: Destinations = {
    smtpHost: 'smtpHost' in input ? (input.smtpHost ?? null) : before.smtpHost,
    ssoProvider:
      'ssoProvider' in input ? (input.ssoProvider ?? null) : before.ssoProvider,
    ssoIssuer:
      'ssoIssuer' in input ? (input.ssoIssuer ?? null) : before.ssoIssuer
  };
  for (const [field, destination] of DESTINATIONS) {
    const stored = before[SECRET_COLUMNS[field]] !== null;
    const moved =
      destination(after) !== null && destination(after) !== destination(before);
    if (stored && moved && !(field in input)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `settings: a new destination for ${field} needs ${field} again`
      );
    }
  }
}
