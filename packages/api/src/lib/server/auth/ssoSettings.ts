import type { Db } from '@zamfono/shared';

import { decrypt, type Keyring } from '../secretbox.js';
import type { SsoConfig } from './oidc.js';

const MICROSOFT_ISSUER_BASE = 'https://login.microsoftonline.com/';
const MICROSOFT_ISSUER_SUFFIX = '/v2.0';
const GOOGLE_ISSUER = 'https://accounts.google.com';

/** `value` of a column §11.4's CHECKs require for the row's `sso_provider`; a row without it
 *  breaks that invariant, which is an error rather than SSO switched off. */
function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`settings: ${column} is unset for the SSO provider`);
  }
  return value;
}

/** The button label: `sso_label`, which §11.4's CHECK requires for `oidc`, or the preset one. */
function buttonLabel(
  provider: SsoConfig['provider'],
  ssoLabel: string | null
): string {
  if (provider === 'microsoft') {
    return ssoLabel ?? 'Microsoft';
  }
  if (provider === 'google') {
    return ssoLabel ?? 'Google';
  }
  return required(ssoLabel, 'sso_label');
}

type SettingsSsoRow = { ssoTenantId: string | null; ssoIssuer: string | null };

/** The issuer for `provider`: the tenant-pinned Microsoft URL, Google's fixed issuer, or the
 *  tenant's own `sso_issuer` for `oidc`. */
function resolveIssuer(
  provider: SsoConfig['provider'],
  row: SettingsSsoRow
): string {
  if (provider === 'microsoft') {
    return `${MICROSOFT_ISSUER_BASE}${required(row.ssoTenantId, 'sso_tenant_id')}${MICROSOFT_ISSUER_SUFFIX}`;
  }
  if (provider === 'google') {
    return GOOGLE_ISSUER;
  }
  return required(row.ssoIssuer, 'sso_issuer');
}

/**
 * Builds the tenant's SSO configuration from `settings`, or `null` while `sso_provider` is unset.
 * `microsoft` pins the issuer to the customer's own tenant, so a token from another tenant fails
 * ordinary issuer validation; `google` uses the fixed workspace issuer.
 */
export async function ssoConfigFromSettings(
  db: Db,
  kr: Keyring
): Promise<SsoConfig | null> {
  const row = await db
    .selectFrom('settings')
    .select([
      'ssoProvider',
      'ssoIssuer',
      'ssoClientId',
      'ssoClientSecretEnc',
      'ssoTenantId',
      'ssoAllowedDomain',
      'ssoLabel'
    ])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  const provider = row.ssoProvider;
  if (provider === null) {
    return null;
  }
  return {
    provider,
    issuer: resolveIssuer(provider, row),
    clientId: required(row.ssoClientId, 'sso_client_id'),
    clientSecret:
      row.ssoClientSecretEnc === null
        ? null
        : decrypt(
            kr,
            'settings.ssoClientSecretEnc',
            row.ssoClientSecretEnc
          ).toString('utf8'),
    tenantId: row.ssoTenantId,
    allowedDomain: row.ssoAllowedDomain,
    label: buttonLabel(provider, row.ssoLabel)
  };
}
