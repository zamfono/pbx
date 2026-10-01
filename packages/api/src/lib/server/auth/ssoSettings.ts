import type { Db } from '@zamfono/shared';

import { decrypt, type Keyring } from '../secretbox.js';
import type { SsoConfig } from './oidc.js';

// §5.2 "Login and SSO": one row (id 1) carries every tenant's SSO configuration.
const SETTINGS_ROW_ID = 1;
const MICROSOFT_ISSUER_BASE = 'https://login.microsoftonline.com/';
const MICROSOFT_ISSUER_SUFFIX = '/v2.0';
const GOOGLE_ISSUER = 'https://accounts.google.com';

function isSsoProvider(value: string): value is SsoConfig['provider'] {
  return value === 'microsoft' || value === 'google' || value === 'oidc';
}

/** The preset button label for `provider` while `sso_label` is unset. §11.4's CHECK requires
 *  `sso_label` for `oidc`, so `provider` falls back to its own name only for a row that check
 *  should already have refused. */
function presetLabel(provider: SsoConfig['provider']): string {
  if (provider === 'microsoft') {
    return 'Microsoft';
  }
  if (provider === 'google') {
    return 'Google';
  }
  return provider;
}

type SettingsSsoRow = { ssoTenantId: string | null; ssoIssuer: string | null };

/** The issuer for `provider`: the tenant-pinned Microsoft URL, Google's fixed issuer, or the
 *  tenant's own `sso_issuer` for `oidc`. */
function resolveIssuer(
  provider: SsoConfig['provider'],
  row: SettingsSsoRow
): string | null {
  if (provider === 'microsoft') {
    if (row.ssoTenantId === null) {
      // Unreachable: the `microsoft` CHECK constraint requires `sso_tenant_id` to be set (§11.4).
      return null;
    }
    return `${MICROSOFT_ISSUER_BASE}${row.ssoTenantId}${MICROSOFT_ISSUER_SUFFIX}`;
  }
  if (provider === 'google') {
    return GOOGLE_ISSUER;
  }
  return row.ssoIssuer;
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
    .where('id', '=', SETTINGS_ROW_ID)
    .executeTakeFirstOrThrow();
  if (
    row.ssoProvider === null ||
    row.ssoClientId === null ||
    !isSsoProvider(row.ssoProvider)
  ) {
    return null;
  }
  const provider = row.ssoProvider;
  const issuer = resolveIssuer(provider, row);
  if (issuer === null) {
    // Unreachable: §11.4's CHECK requires `sso_issuer` for `oidc` and `sso_tenant_id` for
    // `microsoft`.
    return null;
  }
  return {
    provider,
    issuer,
    clientId: row.ssoClientId,
    clientSecret:
      row.ssoClientSecretEnc === null
        ? null
        : decrypt(kr, row.ssoClientSecretEnc).toString('utf8'),
    tenantId: row.ssoTenantId,
    allowedDomain: row.ssoAllowedDomain,
    label: row.ssoLabel ?? presetLabel(provider)
  };
}
