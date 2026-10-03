import * as env from '$app/env/private';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { propagate } from '../propagate.js';
import { defineOperation, OpError, type Role } from '../types.js';
import { settingsInputSchema, type SettingsInput } from './_input.js';
import {
  checkFieldRole,
  loadSettings,
  rowToWire,
  type SettingsColumns,
  type SettingsWire
} from './_shared.js';
import { maybePushTenantProfile, reloadKindsFor } from './changeEffects.js';
import { isKnownCountry } from './country.js';
import { assertNoExtensionCollision } from './emergencyNumbers.js';
import { applyFeatureCodes } from './featureCodes.js';
import { applyPlainFields } from './plainFields.js';
import {
  applyFallbackTarget,
  applyHoldMohAudioId,
  applyMainDidId
} from './referenceFields.js';
import { applySecretFields } from './secrets.js';
import { assertSsoInvariants, maybeResetSsoSubjects } from './sso.js';

const inputSchema = settingsInputSchema;

function assertFieldRoles(input: SettingsInput, role: Role): void {
  for (const field of Object.keys(input) as (keyof SettingsWire)[]) {
    checkFieldRole(field, role);
  }
}

/** Refuses a `country` outside the ISO 3166-1 alpha-2 set libphonenumber knows (§11.4). */
function assertKnownCountry(country: SettingsInput['country']): void {
  if (country !== undefined && !isKnownCountry(country)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `settings: unknown country '${country}'`
    );
  }
}

/** Refuses `callLogLevel: 'sip'` while the deployment mirrors no SIP traffic (§7, §11.4). */
function assertCallLogLevel(level: SettingsInput['callLogLevel']): void {
  if (level === 'sip' && !env.HEP_ENABLED) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "settings: callLogLevel 'sip' requires HEP_ENABLED"
    );
  }
}

/**
 * `PATCH /settings` (§10.3, §11.4): a partial update of the tenant settings row. Owner-only fields
 * are enforced by `checkFieldRole`; the three read-only columns (`extLength`, `ringotelOrgId`,
 * `ringotelBranchId`) are absent from the schema, so submitting them is a plain 422.
 */
export const update = defineOperation<SettingsInput, SettingsWire>({
  name: 'settings.update',
  description:
    'Updates tenant-wide settings: main number, fallback, country, language, mail relay, feature codes, retention, SSO and more; owner-only fields say so',
  input: inputSchema,
  minRole: 'admin',
  entity: () => ({ kind: 'settings', id: 'settings' }),
  run: async (ctx, input) => {
    assertFieldRoles(input, ctx.actor.role);
    const before = await loadSettings(ctx.db);
    assertKnownCountry(input.country);
    await assertNoExtensionCollision(ctx, input.emergencyNumbers);
    assertCallLogLevel(input.callLogLevel);
    assertSsoInvariants(before, input);
    const columns: SettingsColumns = {};
    applyPlainFields(ctx, before, input, columns);
    applyFeatureCodes(ctx, before, input.featureCodes, columns);
    applySecretFields(ctx, input, columns);
    await applyMainDidId(ctx, before, input, columns);
    await applyHoldMohAudioId(ctx, before, input, columns);
    await applyFallbackTarget(ctx, before, input, columns);
    await maybeResetSsoSubjects(ctx, before, input);
    if (Object.keys(columns).length > 0) {
      await ctx.db
        .updateTable('settings')
        .set(columns)
        .where('id', '=', 1)
        .execute();
      // §3.1 "Config propagation": every written column is configuration `core` reads (even a
      // field with no reload kind of its own, `language` among them, §11.4), so `core`'s config
      // cache must drop whether or not Asterisk itself needs a reload — the same unconditional
      // `propagate()` every other operation that writes core-relevant configuration makes
      // (`dids/update.ts`, `ooo/update.ts`, `outboundRoutes/replace.ts`, …); `reloadKinds` only
      // decides which Asterisk modules reload.
      propagate(ctx, reloadKindsFor(columns));
    }
    await maybePushTenantProfile(ctx, columns);
    return rowToWire(ctx.db, await loadSettings(ctx.db));
  }
});
