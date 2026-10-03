import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { recordChange } from '../runner.js';
import { OpError, type Context } from '../types.js';
import type { SettingsRow } from './_shared.js';

/** A `settings.sso_*` binding field: changing any of these invalidates every `users.sso_subject`. */
export const SSO_RESET_FIELDS = [
  'ssoProvider',
  'ssoIssuer',
  'ssoTenantId'
] as const;

/** The `settings.sso_*` fields the §11.2 CHECK constraints jointly constrain. */
const SSO_CHECK_FIELDS = [
  'ssoProvider',
  'ssoClientId',
  'ssoTenantId',
  'ssoIssuer',
  'ssoLabel'
] as const;
type SsoCheckField = (typeof SSO_CHECK_FIELDS)[number];

/**
 * Validates the merged `sso_*` fields against the §11.2 CHECK constraints before writing, so a
 * bad combination answers 422 instead of a raw driver error: a client id is required whenever a
 * provider is set, `microsoft` also requires a tenant id, and `oidc` also requires an issuer and
 * a label.
 */
export function assertSsoInvariants(
  before: SettingsRow,
  input: Record<string, unknown>
): void {
  const beforeRecord = before as unknown as Record<string, unknown>;
  const merged = Object.fromEntries(
    SSO_CHECK_FIELDS.map(field => [
      field,
      field in input ? input[field] : beforeRecord[field]
    ])
  ) as Record<SsoCheckField, unknown>;
  if (merged.ssoProvider !== null && merged.ssoClientId === null) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'settings: ssoClientId is required once ssoProvider is set'
    );
  }
  if (merged.ssoProvider === 'microsoft' && merged.ssoTenantId === null) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "settings: ssoTenantId is required for ssoProvider 'microsoft'"
    );
  }
  if (
    merged.ssoProvider === 'oidc' &&
    (merged.ssoIssuer === null || merged.ssoLabel === null)
  ) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "settings: ssoIssuer and ssoLabel are required for ssoProvider 'oidc'"
    );
  }
}

/** The audit field the bindings an SSO change cleared are recorded under. */
export const SSO_SUBJECTS_FIELD = 'ssoSubjects';

/** One user's `sso_subject` binding (§5.2), as `ssoSubjects` records it in the audit diff. */
export type SsoBinding = { userId: string; ssoSubject: string };

/**
 * Sets every `users.sso_subject` to NULL when an SSO binding field changes (§5.2), recording the
 * cleared bindings as `ssoSubjects`, from the list to `[]`: a `sub` is meaningful only within the
 * issuer that minted it, so undoing the change restores the issuer and, with it, the bindings it
 * minted (`restoreSsoSubjects`).
 */
export async function maybeResetSsoSubjects(
  ctx: Context,
  before: Record<string, unknown>,
  input: Record<string, unknown>
): Promise<void> {
  const changed = SSO_RESET_FIELDS.some(
    field => field in input && input[field] !== before[field]
  );
  if (!changed) {
    return;
  }
  const bound = await ctx.db
    .selectFrom('users')
    .select(['id', 'ssoSubject'])
    .where('ssoSubject', 'is not', null)
    .orderBy('id')
    .execute();
  if (bound.length === 0) {
    return;
  }
  await ctx.db
    .updateTable('users')
    .set({ ssoSubject: null })
    .where('ssoSubject', 'is not', null)
    .execute();
  const bindings: SsoBinding[] = bound.flatMap(row =>
    row.ssoSubject === null
      ? []
      : [{ userId: row.id, ssoSubject: row.ssoSubject }]
  );
  recordChange(ctx, { field: SSO_SUBJECTS_FIELD, from: bindings, to: [] });
}

/**
 * Writes back the bindings an undone SSO change cleared (§5.8), once the replay has restored the
 * issuer that minted them and cleared the bindings made under the undone one.
 */
export async function restoreSsoSubjects(
  ctx: Context,
  bindings: SsoBinding[]
): Promise<void> {
  for (const binding of bindings) {
    // eslint-disable-next-line no-await-in-loop -- one row per binding in the shared transaction
    await ctx.db
      .updateTable('users')
      .set({ ssoSubject: binding.ssoSubject })
      .where('id', '=', binding.userId)
      .execute();
  }
}
